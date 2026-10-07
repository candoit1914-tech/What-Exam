const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const wa = require('./whatsapp');

/**
 * The Paystack paywall: the admin marks a paper `paid`, every invite carries a
 * checkout link, and the paper stays shut until Paystack says the money landed.
 *
 * Nothing here changes a free exam — `isPaidExam` is the single question every
 * call site asks first, and a free paper never creates a payment row, never
 * calls the network and never sends an extra message.
 *
 * Three independent ways to learn the money arrived:
 *   - the webhook (`/webhook/paystack`), which is immediate but needs a public
 *     APP_URL;
 *   - `ensurePaid`, which verifies a still-pending reference against the API on
 *     the student's next reply. A local box with no tunnel still unlocks;
 *   - the background sweep (`startPaymentSweep`), which periodically re-verifies
 *     pending checkouts and re-opens paid papers with no attempt, so a webhook
 *     that never left Paystack cannot strand a paying student.
 */

const PROVIDER = 'paystack';

function isPaidExam(exam) {
  return String((exam && exam.pricing) || 'free') === 'paid';
}

/** GHS major units, e.g. 10 for GHS 10 — what the admin types. */
function priceGhs(exam) {
  return (Number(exam && exam.price_amount) || 0) / 100;
}

/** "GHS 10" — for messages and dashboard labels. */
function priceLabel(exam) {
  const currency = config.paystack.currency || 'GHS';
  const value = priceGhs(exam);
  return `${currency} ${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

function configured() {
  return !!config.paystack.secretKey;
}

function hasPaid(examId, studentId) {
  return !!db
    .prepare(`SELECT id FROM payments WHERE exam_id = ? AND student_id = ? AND status = 'paid'`)
    .get(examId, studentId);
}

function pendingPayment(examId, studentId) {
  return db
    .prepare(
      `SELECT * FROM payments
        WHERE exam_id = ? AND student_id = ? AND status = 'pending'
        ORDER BY id DESC LIMIT 1`
    )
    .get(examId, studentId);
}

/**
 * The whole gate, in one predicate: a paper that is not paid never blocks, a
 * student who has already paid never blocks, and a student who has already
 * STARTED the attempt never gets pulled back out of it if the admin flips a
 * live paper over to paid mid-run.
 */
function requiresPayment(exam, student, session) {
  if (!exam || !isPaidExam(exam)) return false;
  if (session && session.started_at) return false;
  return !hasPaid(exam.id, student.id);
}

function listFor(examId) {
  return db
    .prepare(
      `SELECT p.*, s.phone, s.name AS student_name
         FROM payments p JOIN students s ON s.id = p.student_id
        WHERE p.exam_id = ?
        ORDER BY p.id DESC`
    )
    .all(examId);
}

// ── Paystack API ──────────────────────────────────────────────────────

async function api(pathname, { method = 'GET', body } = {}) {
  if (!configured()) {
    throw new Error('PAYSTACK_SECRET_KEY is not set — cannot take payments.');
  }
  const res = await fetch(`${config.paystack.baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Paystack returned a non-JSON response (${res.status}).`);
  }
  // Paystack reports API failures as 200/4xx with {status:false, message}, so
  // the body has to be checked as well as the HTTP status.
  if (!res.ok || data.status === false) {
    throw new Error(`Paystack ${method} ${pathname} failed: ${data.message || res.status}`);
  }
  return data.data;
}

/** Paystack wants a valid email and we only hold phone numbers. */
function emailFor(student) {
  const digits = String(student.phone || '').replace(/\D/g, '') || '00000000000';
  return `${digits}@${config.appName || 'whatsapp-exam'}.app`;
}

function newReference(exam, student) {
  // Paystack caps references at 50 characters; unique by construction and by
  // the UNIQUE column, so a retry that collides is simply ignored.
  return `wx${exam.id}.${student.id}.${Date.now().toString(36)}${crypto
    .randomBytes(3)
    .toString('hex')}`.slice(0, 50);
}

async function createCheckout(exam, student) {
  const reference = newReference(exam, student);
  const payload = {
    email: emailFor(student),
    amount: Number(exam.price_amount),
    currency: config.paystack.currency,
    reference,
    metadata: { exam_id: exam.id, student_id: student.id, phone: student.phone },
  };
  const callback = config.paystack.callbackUrl;
  if (callback) payload.callback_url = callback;

  const data = await api('/transaction/initialize', { method: 'POST', body: payload });

  db.prepare(
    `INSERT OR IGNORE INTO payments
       (exam_id, student_id, reference, amount, currency, status, authorization_url)
     VALUES (?,?,?,?,?, 'pending', ?)`
  ).run(
    exam.id,
    student.id,
    data.reference || reference,
    Number(exam.price_amount),
    config.paystack.currency,
    data.authorization_url || ''
  );
  return pendingPayment(exam.id, student.id) ||
    db.prepare('SELECT * FROM payments WHERE reference = ?').get(data.reference || reference);
}

/**
 * The link to send. A pending checkout is reused rather than initialized again
 * — replying five times must not create five transactions on the account.
 */
async function checkoutLink(exam, student) {
  const existing = pendingPayment(exam.id, student.id);
  if (existing && existing.authorization_url) return existing.authorization_url;
  const row = await createCheckout(exam, student);
  return row.authorization_url;
}

function linkMessage(exam, link) {
  return (
    `💰 *Payment required*\n\n` +
    `*${exam.title}* is a paid paper. Pay *${priceLabel(exam)}* to open it:\n` +
    `${link}\n\n` +
    `Your exam opens automatically the moment the payment lands — no code to type, no waiting.`
  );
}

/**
 * Send the checkout link to one student. Every failure mode falls back to a
 * plain, honest message rather than silence: a student who cannot pay right now
 * must be told why, not left staring at an invite.
 */
async function deliverLink(student, exam) {
  const link = await checkoutLink(exam, student);
  await wa.sendText(student.phone, linkMessage(exam, link));
  return link;
}

/** Same as deliverLink, but never throws — used on paths that must not fail. */
async function tryDeliverLink(student, exam) {
  try {
    return await deliverLink(student, exam);
  } catch (err) {
    console.error(`[pay] checkout link to ${student.phone} failed: ${err.message}`);
    try {
      await wa.sendText(
        student.phone,
        `💰 *Payment required*\n\n*${exam.title}* costs *${priceLabel(exam)}*. ` +
          `Please reply again in a moment to get your payment link.`
      );
    } catch { /* nothing more we can do; the next reply retries */ }
    return null;
  }
}

// ── Verification ──────────────────────────────────────────────────────

/**
 * Paystack signs the raw body with HMAC-SHA512 of the secret key. Compared in
 * constant time; an unsigned or unsigned-looking request never reaches the DB.
 */
function signatureValid(rawBody, signature) {
  if (!configured() || !signature) return false;
  const expected = crypto
    .createHmac('sha512', config.paystack.secretKey)
    .update(rawBody || Buffer.alloc(0))
    .digest('hex');
  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Record a successful charge. Returns `{ first }` — `first` is true only for
 * the transition out of 'pending', which is what lets the caller send the
 * unlock messages exactly once no matter how many times Paystack retries.
 */
function applyCharge({ reference, amount, currency, channel, paidAt, status = 'paid' }) {
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) return { found: false, first: false };

  const wanted = config.paystack.currency;
  if (currency && String(currency).toUpperCase() !== String(wanted).toUpperCase()) {
    console.warn(`[pay] ${reference} paid in ${currency}, expected ${wanted} — not unlocking`);
    return { found: true, first: false, mismatched: true };
  }
  if (Number(amount) > 0 && Number(amount) !== Number(payment.amount)) {
    console.warn(`[pay] ${reference} paid ${amount}, expected ${payment.amount} — not unlocking`);
    return { found: true, first: false, mismatched: true };
  }
  if (status !== 'paid') {
    db.prepare(
      `UPDATE payments SET status = ?, updated_at = datetime('now') WHERE reference = ? AND status = 'pending'`
    ).run(status, reference);
    return { found: true, first: false };
  }

  const info = db
    .prepare(
      `UPDATE payments
          SET status = 'paid', channel = ?, paid_at = ?, updated_at = datetime('now')
        WHERE reference = ? AND status <> 'paid'`
    )
    .run(channel || '', paidAt || new Date().toISOString(), reference);
  return { found: true, first: info.changes === 1, payment: db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference) };
}

/**
 * Ask Paystack directly. This is the safety net for a webhook that never
 * arrived (no public URL, a tunnel that dropped, an outage during checkout).
 */
async function verifyReference(reference) {
  const data = await api(`/transaction/verify/${encodeURIComponent(reference)}`);
  const charge = data && data.transaction ? data.transaction : data;
  if (!charge || charge.status !== 'success') return null;
  return {
    reference: charge.reference || reference,
    amount: charge.amount,
    currency: charge.currency,
    channel: charge.channel || '',
    paidAt: charge.paid_at || null,
  };
}

/**
 * The gate every inbound message passes through for a paid paper.
 *
 * Returns `{ paid, confirmed }`. A student whose payment we only just recorded
 * here (the webhook never arrived) is told so inline — they are actively
 * messaging us, so the send works — and the caller carries straight on into the
 * normal start flow. The exam is deliberately NOT started from here: that would
 * race the caller's own start.
 */
async function ensurePaid(exam, student, session) {
  if (!exam || !isPaidExam(exam)) return { paid: true };
  if (hasPaid(exam.id, student.id)) return { paid: true };
  if (!session || !session.started_at) {
    const pending = pendingPayment(exam.id, student.id);
    if (pending && configured()) {
      try {
        const charge = await verifyReference(pending.reference);
        if (charge) {
          const outcome = applyCharge(charge);
          if (outcome.first) {
            console.log(`[pay] ${pending.reference} confirmed by verification (webhook never arrived)`);
            await wa.sendText(student.phone, confirmationMessage(exam));
            return { paid: true, confirmed: true };
          }
          if (hasPaid(exam.id, student.id)) return { paid: true };
        }
      } catch (err) {
        // A Paystack outage must not trap a paying student: fall through and
        // re-send the link, and let the webhook (or the next reply) unlock them.
        console.warn(`[pay] verify ${pending.reference} failed: ${err.message}`);
      }
    }
  }
  return { paid: false };
}

function confirmationMessage(exam) {
  return `✅ *Payment received* — *${priceLabel(exam)}* for *${exam.title}*.\n\nYour exam is opening now…`;
}

/**
 * The money landed while the student was NOT messaging us: tell them and open
 * the paper. This is the webhook's path; ensurePaid covers the reply path.
 *
 * The two steps are deliberately independent. They used to share one try
 * block, so when the confirmation push failed — a closed 24h window, a rate
 * limit, a timeout — the paper was never opened and the student was left
 * holding only a receipt. A paper someone paid for must not depend on a
 * chat message succeeding.
 */
async function unlock(payment, exam, student) {
  const examRow = exam || db.prepare('SELECT * FROM exams WHERE id = ?').get(payment.exam_id);
  const studentRow = student || db.prepare('SELECT * FROM students WHERE id = ?').get(payment.student_id);
  if (!examRow || !studentRow) return false;

  try {
    await wa.sendText(studentRow.phone, confirmationMessage(examRow));
  } catch (err) {
    console.warn(`[pay] payment confirmation to ${studentRow.phone} failed: ${err.message}`);
  }

  // Lazy require: exam.js loads this module at require time, so requiring it
  // back at module scope would hand us a half-initialised exports object.
  const examService = require('./exam');
  try {
    await examService.maybeStartSession(studentRow);
  } catch (err) {
    // hasPaid is already true, so the student's next reply opens the paper.
    console.error(
      `[pay] could not open ${examRow.title} for ${studentRow.phone}: ${err.message}. `
      + 'Their next reply opens it; the background sweep retries the push.'
    );
    return false;
  }
  // Answering — even with "no pending exams" or "already finished" —
  // means the student was told something definitive, so the sweep has
  // nothing left to do for this payment. Only a throw (a failed send,
  // a redeploy mid-push) earns a retry.
  return true;
}

/** Fire-and-forget for the webhook, which must answer Paystack quickly. */
function unlockAsync(payment, exam, student) {
  unlock(payment, exam, student).catch((err) => console.error(`[pay] unlock failed: ${err.message}`));
}

// ── Background sweep ─────────────────────────────────────────────
//
// The webhook is the fast path, but it is a single point of failure:
// the URL can be unregistered in the Paystack dashboard, a deploy can
// land while an event is in flight, or the event can simply never
// leave Paystack. A sweep of the payments table makes "the exam opens
// automatically" independent of the webhook arriving at all — a paid
// student waits at most one sweep interval, never a reply.

/** Pending checkouts older than this are abandoned; verifying them is API spend. */
const PENDING_MAX_AGE = '6 hours';
/** How often one reference may be re-asked about, and how many times. */
const PENDING_COOLDOWN_MS = 120_000;
const PENDING_ATTEMPTS = 10;
const SWEEP_BATCH = 20;
/** A paid paper whose unlock push threw is re-pushed a few times. */
const OPEN_ATTEMPTS = 3;
const OPEN_MAX_AGE = '24 hours';
/** Give the webhook's own unlock a head start before a sweep repeats it. */
const OPEN_GRACE = '90 seconds';

const pendingChecks = new Map(); // reference -> { at, attempts }
const openRetries = new Map();   // reference -> attempts
/** Session states with nothing left to deliver to the student. */
const DELIVERED_EXCEPT = new Set(['completed', 'ended', 'expired', 'finalizing']);
let sweeping = false;
let sweepTimer = null;

/**
 * Verify every still-pending checkout and unlock anything that settled
 * unnoticed. Never throws: a sweep that dies halfway must not take the
 * next one down with it.
 */
async function verifyPendingPayments({ now = Date.now() } = {}) {
  if (!configured() || sweeping) return { settled: 0, opened: 0 };
  sweeping = true;
  try {
    const settled = await settlePendingPayments(now);
    const opened = await openPaidPapers();
    if (settled || opened) {
      console.log(`[pay] sweep settled ${settled} and opened ${opened}`);
    }
    return { settled, opened };
  } finally {
    sweeping = false;
  }
}

async function settlePendingPayments(now) {
  const rows = db
    .prepare(
      `SELECT * FROM payments
        WHERE status = 'pending' AND created_at >= datetime('now', ?)
        ORDER BY id DESC LIMIT ?`
    )
    .all(`-${PENDING_MAX_AGE}`, SWEEP_BATCH);
  let settled = 0;
  for (const row of rows) {
    const seen = pendingChecks.get(row.reference);
    if (seen && (now - seen.at < PENDING_COOLDOWN_MS || seen.attempts >= PENDING_ATTEMPTS)) continue;
    pendingChecks.set(row.reference, { at: now, attempts: (seen ? seen.attempts : 0) + 1 });

    let charge;
    try {
      charge = await verifyReference(row.reference);
    } catch (err) {
      // "reference not found" is the normal answer for a checkout that
      // was initialized but never paid; anything louder still must not
      // stop the sweep.
      console.warn(`[pay] sweep verify ${row.reference} failed: ${err.message}`);
      continue;
    }
    if (!charge) continue; // still pending on Paystack's side
    const outcome = applyCharge(charge);
    if (outcome.first) {
      console.log(`[pay] ${row.reference} settled by background verification — the webhook never arrived`);
      settled++;
      await unlock(outcome.payment, null, null);
    }
  }
  return settled;
}

/**
 * Open the paper for anyone who paid but still has no attempt. The
 * webhook's unlock ran (or failed) at least OPEN_GRACE ago, so this
 * only ever repeats work that did not stick — and only a few times,
 * because nagging a student who deliberately has not started yet would
 * be worse than silence.
 */
async function openPaidPapers() {
  const rows = db
    .prepare(
      `SELECT p.*, s.phone, s.name AS student_name
         FROM payments p JOIN students s ON s.id = p.student_id
        WHERE p.status = 'paid'
          AND datetime(p.paid_at) >= datetime('now', ?)
          AND datetime(p.paid_at) <= datetime('now', ?)
        ORDER BY p.id DESC LIMIT ?`
    )
    .all(`-${OPEN_MAX_AGE}`, `-${OPEN_GRACE}`, SWEEP_BATCH);
  let opened = 0;
  for (const row of rows) {
    const attempts = openRetries.get(row.reference) || 0;
    if (attempts >= OPEN_ATTEMPTS) continue;
    // Has the paper already been delivered for this attempt? A
    // session is created when the admin sends, with started_at NULL
    // (the clock only starts when the student engages), so a NULL
    // started_at on an in_progress session still needs its paper —
    // maybeStartSession re-sends the intro and question 1 for it.
    // Anything the student has engaged with, or that has already run
    // its course, has nothing left to deliver.
    const session = db
      .prepare(
        `SELECT status, started_at FROM sessions
          WHERE exam_id = ? AND student_id = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(row.exam_id, row.student_id);
    if (
      session
      && (session.started_at || DELIVERED_EXCEPT.has(session.status))
    ) {
      openRetries.set(row.reference, OPEN_ATTEMPTS);
      continue;
    }
    openRetries.set(row.reference, attempts + 1);
    console.log(`[pay] opening ${row.reference} for ${row.phone} (push attempt ${attempts + 1})`);
    if (await unlock(row, null, null)) {
      opened++;
      // Delivered: never re-push this payment.
      openRetries.set(row.reference, OPEN_ATTEMPTS);
    }
  }
  return opened;
}

/** Run the sweep on an interval. Safe to call more than once. */
function startPaymentSweep(intervalMs = 60_000) {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    verifyPendingPayments().catch((err) => {
      console.error('[pay] payment sweep error:', err.message);
    });
  }, intervalMs);
  // Don't keep the process alive just for the sweep.
  if (sweepTimer.unref) sweepTimer.unref();
  console.log(`[pay] payment sweep started (interval: ${intervalMs}ms)`);
}

function stopPaymentSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  isPaidExam,
  priceGhs,
  priceLabel,
  configured,
  hasPaid,
  pendingPayment,
  requiresPayment,
  listFor,
  createCheckout,
  checkoutLink,
  deliverLink,
  tryDeliverLink,
  signatureValid,
  applyCharge,
  verifyReference,
  ensurePaid,
  unlock,
  unlockAsync,
  verifyPendingPayments,
  startPaymentSweep,
  stopPaymentSweep,
};
