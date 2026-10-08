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
const realSendTemplate = wa.sendTemplate;
const realFetch = global.fetch;

let server;
let base;
let token;
let sent = [];
let sentTemplates = [];
let seq = 0;

// ── helpers ───────────────────────────────────────────────────────────

/** Capture everything the bot would say, so a test can read the conversation. */
function capture() {
  sent = [];
  sentTemplates = [];
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
  wa.sendTemplate = realSendTemplate;
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

test('a free exam grades the first answer instead of re-sending question 1', async () => {
  capture();
  paystackStub();
  const eid = makeExam();
  const student = addStudent(eid);
  await exam.sendExamToRecipients(eid);
  sent.length = 0;

  // The first reply opens the paper and delivers question 1.
  const opened = await exam.handleInbound(student.phone, 'hello');
  assert.equal(opened.reason, 'started');
  assert.ok(sent.some((m) => m.includes('QUESTION 1')));
  sent.length = 0;

  // The next reply is an ANSWER to question 1 — it must be recorded
  // and the exam must advance, not be read as another "start".
  const outcome = await exam.handleInbound(student.phone, 'A');
  assert.equal(outcome.reason, 'answered', 'the answer must be graded, not swallowed as a start');
  assert.ok(sent.some((m) => m.includes('QUESTION 2')), 'the exam advances to question 2');
  const answer = db
    .prepare(
      `SELECT a.answer_text FROM answers a
        JOIN sessions s ON s.id = a.session_id
        WHERE s.exam_id = ? AND s.student_id = ? AND a.q_order = 1`
    )
    .get(eid, student.id);
  assert.ok(answer, 'the answer is recorded');
  assert.equal(answer.answer_text, 'A');
});

// ── paid papers ───────────────────────────────────────────────────────

test('a paid exam sends only the payment bubble, never the invite', async () => {
  capture();
  paystackStub();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  addStudent(eid);

  const report = await exam.sendExamToRecipients(eid);

  assert.equal(report.sent, 1, 'still one recipient, one delivery report entry');
  assert.equal(sent.length, 1, 'one message: the payment bubble, and nothing behind it');
  assert.match(sent[0], /checkout\.paystack\.com/, 'the message is the Paystack link');
  assert.ok(sent[0].includes('GHS 10'), 'and it says what it costs');
  assert.ok(!sent.some((m) => m.includes('INSTRUCTIONS')), 'the invite must not come along');
  assert.ok(
    !sent.some((m) => m.includes('Reply *START*')),
    'the student is never told to START a paper they have not paid for'
  );

  const [payment] = paymentsFor(eid);
  assert.equal(payment.status, 'pending');
  assert.equal(payment.amount, 1000);
  assert.equal(payment.currency, 'GHS');
});

test('a paid checkout can be sent with an approved WhatsApp template', async () => {
  capture();
  paystackStub();
  const previous = config.whatsapp.paymentTemplateName;
  config.whatsapp.paymentTemplateName = 'paid_checkout_test';
  wa.sendTemplate = async (phone, name, language, params) => {
    sentTemplates.push({ phone, name, language, params });
    return { messages: [{ id: 'mock-template' }] };
  };
  try {
    const eid = makeExam({ pricing: 'paid', amount: 1000 });
    const student = addStudent(eid);
    await exam.sendExamToRecipients(eid);
    assert.equal(sentTemplates.length, 1, 'only the payment template goes out — no invite template behind it');
    const paymentTemplate = sentTemplates.find((item) => item.name === 'paid_checkout_test');
    assert.ok(paymentTemplate, 'checkout is delivered by the approved payment template');
    assert.deepEqual(paymentTemplate.params.map((item) => item.text).slice(0, 2), ['Paywall Paper', 'GHS 10']);
    assert.match(paymentTemplate.params[2].text, /^https:\/\/checkout\.paystack\.com\//);
    assert.equal(paymentTemplate.phone, student.phone);
  } finally {
    config.whatsapp.paymentTemplateName = previous;
    wa.sendTemplate = realSendTemplate;
  }
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

test('a paid send whose link cannot be delivered fails loudly and leaks no invite', async () => {
  // The API refuses a paid send with no key before anything goes out. This is
  // the other side of the same rule: the gateway dies after the send has
  // started, so the recipient must land in the failed column where the retry
  // cron can find them — not in the sent column with only an apology behind it.
  capture();
  config.paystack.secretKey = '';
  try {
    const eid = makeExam({ pricing: 'paid', amount: 1000 });
    addStudent(eid);

    const report = await exam.sendExamToRecipients(eid);

    assert.equal(report.sent, 0, 'nobody received anything usable');
    assert.equal(report.failed, 1, 'and the report says so');
    assert.ok(
      !sent.some((m) => m.includes('INSTRUCTIONS')),
      'the invite must not leak out behind a dead gateway'
    );
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

  // From here the student is an ordinary student again: their next
  // message is an answer to question 1, not another "start".
  const outcome = await exam.handleInbound(student.phone, 'A');
  assert.equal(outcome.reason, 'answered', `got ${outcome.reason}`);
  assert.notEqual(outcome.reason, 'payment_required');
});

test('a paid exam can deliver its first question in an approved start template', async () => {
  capture();
  paystackStub();
  const previous = config.whatsapp.paidStartTemplateName;
  config.whatsapp.paidStartTemplateName = 'paid_exam_start_test';
  wa.sendTemplate = async (phone, name, language, params) => {
    sentTemplates.push({ phone, name, language, params });
    return { messages: [{ id: 'mock-template' }] };
  };
  try {
    const eid = makeExam({ pricing: 'paid', amount: 1000 });
    const student = addStudent(eid);
    await exam.sendExamToRecipients(eid);
    const [payment] = paymentsFor(eid);
    const raw = JSON.stringify({
      event: 'charge.success',
      data: { reference: payment.reference, amount: 1000, currency: 'GHS', channel: 'mobile_money' },
    });
    assert.equal((await postWebhook(raw, sign(raw))).status, 200);
    await waitFor(
      () => sentTemplates.some((item) => item.name === 'paid_exam_start_test'),
      'the approved paid exam start template'
    );
    const start = sentTemplates.find((item) => item.name === 'paid_exam_start_test');
    assert.equal(start.phone, student.phone);
    assert.equal(start.params[0].text, 'Paywall Paper');
    assert.match(start.params[1].text, /QUESTION 1/);
    assert.match(start.params[1].text, /A\. Yes/);
    assert.equal(start.params[2].text, '30');
    assert.ok(sessionFor(eid, student.id).started_at);
  } finally {
    config.whatsapp.paidStartTemplateName = previous;
    wa.sendTemplate = realSendTemplate;
  }
});

test('payment arms the clock and the first answer is graded at once', async () => {
  capture();
  paystackStub();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  await exam.sendExamToRecipients(eid);
  const [payment] = paymentsFor(eid);
  sent.length = 0;

  // The student pays; Paystack fires the webhook.
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
  assert.equal(res.status, 200);
  await waitFor(() => sent.some((m) => m.includes('QUESTION 1')), 'the paper to open');

  // The exam starts the moment payment lands: the countdown is
  // running before the student types anything.
  assert.ok(sessionFor(eid, student.id).started_at, 'the clock is armed by the payment');
  sent.length = 0;

  // The student's very next message is an answer, and it must be
  // recorded — not swallowed as another "start" with question 1
  // re-sent.
  const outcome = await exam.handleInbound(student.phone, 'A');
  assert.equal(outcome.reason, 'answered', `got ${outcome.reason}`);
  assert.ok(sent.some((m) => m.includes('QUESTION 2')), 'the exam advances');
  const answer = db
    .prepare(
      `SELECT a.answer_text FROM answers a
        JOIN sessions s ON s.id = a.session_id
        WHERE s.exam_id = ? AND s.student_id = ? AND a.q_order = 1`
    )
    .get(eid, student.id);
  assert.ok(answer, 'the answer is recorded');
  assert.equal(answer.answer_text, 'A');
});

test('unlock opens the paper that was paid for, not the newest one', async () => {
  capture();
  paystackStub();
  // Two live papers, the second one newer. A student holds both.
  const paid = makeExam({ pricing: 'paid', amount: 1000 });
  const other = makeExam();
  db.prepare("UPDATE exams SET published_at = datetime('now','-1 hour') WHERE id = ?").run(paid);
  db.prepare("UPDATE exams SET published_at = datetime('now') WHERE id = ?").run(other);
  const student = addStudent(paid);
  db.prepare('INSERT OR IGNORE INTO exam_recipients(exam_id, student_id) VALUES (?,?)').run(other, student.id);

  const payment = paidPayment(paid, student.id, 'wx-preferred-paper');
  payments.applyCharge({ reference: 'wx-preferred-paper', amount: 1000, currency: 'GHS' });
  await payments.unlock(payment, null, null);

  const opened = sessionFor(paid, student.id);
  assert.ok(opened && opened.started_at, 'the paid paper opened');
  assert.equal(sessionFor(other, student.id), undefined, 'the other paper must stay shut');
  assert.ok(sent.some((m) => m.includes('QUESTION 1')), 'and its question 1 went out');
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

test('a charge missing its amount or currency is not accepted as paid', async () => {
  capture();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  db.prepare(
    `INSERT INTO payments (exam_id, student_id, reference, amount, currency, status, authorization_url)
     VALUES (?,?,?,?, 'GHS', 'pending', 'https://checkout.paystack.com/x')`
  ).run(eid, student.id, 'ref-incomplete', 1000);

  const missingAmount = { reference: 'ref-incomplete', currency: 'GHS' };
  const missingCurrency = { reference: 'ref-incomplete', amount: 1000 };
  assert.equal(payments.applyCharge(missingAmount).mismatched, true);
  assert.equal(payments.applyCharge(missingCurrency).mismatched, true);
  assert.equal(db.prepare('SELECT status FROM payments WHERE reference=?').get('ref-incomplete').status, 'pending');
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
  assert.match(
    sent.find((m) => m.includes('Payment received')),
    /type \*Hi\* or \*Exam\*/,
    'and is told how to start the paper when it does not open by itself'
  );
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

// ── The unlock itself ───────────────────────────────────────

/** A payment row for a student who paid outside this test's sends. */
function paidPayment(eid, sid, reference, { status = 'pending', paidAt = null } = {}) {
  db.prepare(
    `INSERT INTO payments
       (exam_id, student_id, reference, amount, currency, status, authorization_url, paid_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    eid, sid, reference, 1000, 'GHS', status,
    `https://checkout.paystack.com/${reference}`,
    paidAt
  );
  return db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
}

/** sendText that fails on the first `failures` calls, then works. */
function flakySendText(failures = 1) {
  let left = failures;
  wa.sendText = async (phone, text) => {
    if (left-- > 0) throw new Error('24h window closed');
    sent.push(text);
    return { messages: [{ id: 'mock' }] };
  };
}

test('a confirmation push that fails must not cost the student their paper', async () => {
  capture();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  const payment = paidPayment(eid, student.id, 'wx-confirm-drop');
  payments.applyCharge({ reference: 'wx-confirm-drop', amount: 1000, currency: 'GHS' });

  // WhatsApp rejects the very first push (closed window, rate limit,
  // timeout — any of them used to abort the whole unlock).
  flakySendText(1);
  const opened = await payments.unlock(payment, null, null);

  assert.equal(opened, true, 'the unlock reports success');
  const session = sessionFor(eid, student.id);
  assert.ok(session && session.started_at, 'the paper opened anyway');
  assert.ok(sent.some((m) => m.includes('QUESTION 1')), 'and the first question went out');
});

// ── The background sweep ────────────────────────────────────

test('the sweep settles a pending payment the webhook never reported', async () => {
  capture();
  paystackStub({ verifyStatus: 'success' });
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  paidPayment(eid, student.id, 'wx-sweep-settle');
  assert.equal(payments.hasPaid(eid, student.id), false);

  const out = await payments.verifyPendingPayments();

  assert.ok(out.settled >= 1, `the pending payment was settled (settled ${out.settled})`);
  assert.equal(payments.hasPaid(eid, student.id), true, 'the money is recorded');
  const session = sessionFor(eid, student.id);
  assert.ok(session && session.started_at, 'the paper opened with no webhook and no reply');
  assert.ok(sent.some((m) => m.includes('Payment received')), 'the student is told');
  assert.ok(sent.some((m) => m.includes('QUESTION 1')), 'and gets the paper');
});

test('the sweep re-opens the paper for a student whose unlock push failed', async () => {
  capture();
  // Paystack is unreachable here: this student already paid, the
  // webhook landed, but the unlock could not open the paper.
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
  paidPayment(eid, student.id, 'wx-sweep-reopen', { status: 'paid', paidAt: anHourAgo });
  assert.equal(sessionFor(eid, student.id), undefined, 'no attempt exists yet');

  const out = await payments.verifyPendingPayments();

  assert.ok(out.opened >= 1, `the paid paper was pushed (opened ${out.opened})`);
  assert.ok(sessionFor(eid, student.id).started_at, 'the paper opened');
  assert.ok(sent.some((m) => m.includes('QUESTION 1')), 'and the questions went out');
});

test('the sweep is a no-op until a secret key is configured', async () => {
  const saved = config.paystack.secretKey;
  config.paystack.secretKey = '';
  try {
    assert.deepEqual(await payments.verifyPendingPayments(), { settled: 0, opened: 0 });
  } finally {
    config.paystack.secretKey = saved;
  }
});
