'use strict';
require('./helpers/isolate');

// The sweep's guarantee — a paid paper opens with no webhook
// and no reply — is pinned by the sweep tests in
// test/paid-exams.test.js. What is pinned here is everything
// the sweep must NOT do: touch a checkout Paystack still
// calls pending, nag a student mid-paper, or die on a gateway
// outage — plus the fact that it runs on its own timer and
// stops cleanly.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const config = require('../src/config');
const payments = require('../src/services/payments');
const wa = require('../src/services/whatsapp');

const SECRET = 'sk_test_sweep';
const realSendText = wa.sendText;
const realFetch = global.fetch;

let sent = [];
let seq = 0;
// What the fake Paystack says when a reference is verified.
let verifyStatus = 'success';
let verifyFails = false;

function capture() {
  sent = [];
  verifyStatus = 'success';
  verifyFails = false;
  wa.sendText = async (phone, text) => {
    sent.push(text);
    return { messages: [{ id: 'mock' }] };
  };
}

function jsonResponse(status, body) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function paystackStub() {
  global.fetch = async (url) => {
    const s = String(url);
    if (s.endsWith('/transaction/initialize')) {
      const reference = `wxinit${Date.now().toString(36)}${++seq}`;
      return jsonResponse(200, {
        status: true,
        data: {
          reference,
          access_code: 'ac',
          authorization_url: `https://checkout.paystack.com/${reference}`,
        },
      });
    }
    if (s.includes('/transaction/verify/')) {
      if (verifyFails) throw new Error('gateway timeout');
      const reference = decodeURIComponent(s.split('/').pop());
      const row = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
      return jsonResponse(200, {
        status: true,
        data: {
          status: verifyStatus,
          reference,
          amount: row ? row.amount : 0,
          currency: row ? row.currency : 'GHS',
          channel: 'mobile_money',
          paid_at: new Date().toISOString(),
        },
      });
    }
    throw new Error(`unexpected gateway call: ${s}`);
  };
}

function makeExam({ amount = 1000 } = {}) {
  return db
    .prepare(
      `INSERT INTO exams (title, duration_minutes, status, pricing, price_amount)
       VALUES ('Sweep Paper', 30, 'live', 'paid', ?)`
    )
    .run(amount).lastInsertRowid;
}

function addStudent(eid) {
  const phone = `233sweep${++seq}${String(eid).padStart(4, '0')}`;
  const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id, student_id) VALUES (?,?)').run(eid, sid);
  // Two questions on purpose: the last answer finalises the session,
  // which would drag results/AI into a test that is about the sweep.
  for (const order of [1, 2]) {
    db.prepare(
      `INSERT INTO questions(exam_id, q_order, type, text, options, correct_answer)
       VALUES (?, ?, 'objective', ?, ?, 'A')`
    ).run(eid, order, `Sweep question ${order}`, JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]));
  }
  return db.prepare('SELECT * FROM students WHERE id=?').get(sid);
}

/** A checkout that was initialized but never confirmed by the webhook. */
function pendingPayment(eid, student) {
  const reference = `wx${eid}.${student.id}.${Date.now().toString(36)}${++seq}`;
  db.prepare(
    `INSERT INTO payments (exam_id, student_id, reference, amount, currency, status, authorization_url)
     VALUES (?,?,?,?, 'GHS', 'pending', 'https://checkout.paystack.com/x')`
  ).run(eid, student.id, reference, 1000);
  return db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
}

/** A charge Paystack has already settled, recorded paid `minutesAgo` ago. */
function paidPayment(eid, student, minutesAgo = 5) {
  const reference = `wx${eid}.${student.id}.paid${Date.now().toString(36)}${++seq}`;
  const paidAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.prepare(
    `INSERT INTO payments (exam_id, student_id, reference, amount, currency, status, paid_at, authorization_url)
     VALUES (?,?,?,?, 'GHS', 'paid', ?, 'https://checkout.paystack.com/x')`
  ).run(eid, student.id, reference, 1000, paidAt);
  return db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
}

function paymentRow(id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

function sessionFor(eid, sid) {
  return db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?').get(eid, sid);
}

before(() => {
  config.paystack.secretKey = SECRET;
  config.paystack.baseUrl = 'https://api.paystack.test';
  config.paystack.currency = 'GHS';
});

after(() => {
  wa.sendText = realSendText;
  global.fetch = realFetch;
  payments.stopPaymentSweep();
});

test('a checkout Paystack still calls pending is left alone', async () => {
  capture();
  verifyStatus = 'pending';
  paystackStub();
  const eid = makeExam();
  const student = addStudent(eid);
  const payment = pendingPayment(eid, student);

  const out = await payments.verifyPendingPayments();

  assert.equal(out.settled, 0);
  assert.equal(out.opened, 0);
  assert.equal(paymentRow(payment.id).status, 'pending');
  assert.equal(sent.length, 0, 'nothing may go out for an unpaid checkout');
  assert.equal(sessionFor(eid, student.id), undefined, 'no session may exist for an unpaid student');
});

test('a gateway outage during a sweep changes nothing and never throws', async () => {
  capture();
  verifyFails = true;
  paystackStub();
  const eid = makeExam();
  const student = addStudent(eid);
  const payment = pendingPayment(eid, student);

  const out = await payments.verifyPendingPayments();

  assert.deepEqual(out, { settled: 0, opened: 0 });
  assert.equal(paymentRow(payment.id).status, 'pending');
  assert.equal(sent.length, 0);
});

test('a paper the student already started is not re-pushed', async () => {
  capture();
  paystackStub();
  const eid = makeExam();
  const student = addStudent(eid);
  paidPayment(eid, student, 5);
  db.prepare(
    `INSERT INTO sessions (exam_id, student_id, status, started_at)
     VALUES (?,?, 'in_progress', datetime('now'))`
  ).run(eid, student.id);

  const out = await payments.verifyPendingPayments();

  assert.equal(out.opened, 0);
  assert.equal(sent.length, 0, 'a student mid-paper must not be nagged');
});

test('the sweep runs on its own timer and stops cleanly', async () => {
  capture();
  paystackStub();
  const eid = makeExam();
  const student = addStudent(eid);
  const payment = pendingPayment(eid, student);

  payments.startPaymentSweep(25);
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (paymentRow(payment.id).status === 'paid') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  payments.stopPaymentSweep();
  payments.stopPaymentSweep(); // stopping twice is a no-op

  assert.equal(
    paymentRow(payment.id).status,
    'paid',
    'the timer settled the payment with no reply from the student'
  );
  assert.ok(sent.some((m) => m.includes('QUESTION 1')), 'and opened the paper');
});
