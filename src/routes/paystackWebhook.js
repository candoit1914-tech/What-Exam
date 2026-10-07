const express = require('express');
const config = require('../config');
const payments = require('../services/payments');

const router = express.Router();

/**
 * Paystack charge notifications.
 *
 * Mounted BEFORE express.json() in server.js (like the WhatsApp webhook) and
 * parsing the body as raw bytes here, because the x-paystack-signature header
 * is an HMAC-SHA512 of the exact bytes Paystack sent — any re-serialisation
 * would break verification.
 *
 * The response is sent before any WhatsApp work so a slow send can never make
 * Paystack time out and retry the event into a second unlock.
 */
router.post('/', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
  if (!payments.configured()) {
    console.error('[pay] webhook received but PAYSTACK_SECRET_KEY is not set — rejecting');
    return res.status(503).send('Paystack is not configured');
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
  const signature = String(req.headers['x-paystack-signature'] || '');
  if (!payments.signatureValid(raw, signature)) {
    console.warn('[pay] signature mismatch — rejecting spoofed Paystack event');
    return res.status(401).send('Invalid signature');
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON payload');
  }

  const event = body && body.event;
  const data = body && body.data;
  if (!data || !data.reference) return res.sendStatus(200);
  // Every other event (session created, authorization created, transfer) is
  // acknowledged and ignored — only a settled charge unlocks a paper.
  if (event !== 'charge.success' && event !== 'charge.failed') return res.sendStatus(200);

  const outcome = payments.applyCharge({
    reference: data.reference,
    amount: data.amount,
    currency: data.currency,
    channel: data.channel,
    paidAt: data.paid_at,
    status: event === 'charge.success' ? 'paid' : 'failed',
  });
  const label = !outcome.found
    ? 'unknown reference'
    : outcome.mismatched
      ? 'rejected (amount/currency mismatch)'
      : outcome.first
        ? 'unlocked'
        : 'already recorded';
  console.log(`[pay] ${event} ${data.reference} → ${label}`);
  res.sendStatus(200);

  if (outcome.first) {
    payments.unlockAsync(outcome.payment, null, null);
  }
});

module.exports = router;
