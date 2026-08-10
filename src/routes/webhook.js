const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const wa = require('../services/whatsapp');
const db = require('../db');
const examService = require('../services/exam');

const router = express.Router();

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (!config.whatsapp.verifyToken) {
    console.error('[webhook] WHATSAPP_VERIFY_TOKEN not configured — refusing verification');
    return res.status(403).send('Verification failed');
  }
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Verification failed');
});

router.post('/', express.raw({ type: () => true }), async (req, res) => {
  if (!config.whatsapp.appSecret) {
    console.error('[webhook] WHATSAPP_APP_SECRET not configured — rejecting unsigned webhook');
    return res.status(403).send('Webhook signature verification unavailable');
  }

  const signature = String(req.headers['x-hub-signature-256'] || '');
  const expected = signature.startsWith('sha256=') ? signature.slice(7) : '';
  const computed = crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.body || Buffer.alloc(0)).digest('hex');
  if (!expected || !timingSafeEqualHex(computed, expected)) {
    console.warn('[webhook] signature mismatch — rejecting spoofed webhook event');
    return res.status(403).send('Signature verification failed');
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    return res.status(400).send('Invalid JSON payload');
  }

  // Log every verified inbound POST for diagnostics (helps us see if Meta is delivering).
  try {
    db.prepare('INSERT INTO webhook_events (source, payload) VALUES (?,?)').run('inbound', JSON.stringify(body).slice(0, 2000));
  } catch (e) { /* non-fatal */ }
  res.status(200).send('OK'); // acknowledge immediately
  console.log('[webhook] POST', JSON.stringify(body).slice(0, 400));

  const events = wa.parseWebhook(body);
  for (const ev of events) {
    if (ev.type === 'status') {
      console.log(`[webhook] status for ${ev.messageId}: ${ev.status}${ev.error ? ' (' + ev.error + ')' : ''}`);
      db.prepare(
        `UPDATE outbound_messages SET status = ?, error = ?, updated_at = datetime('now') WHERE message_id = ?`
      ).run(ev.status, ev.error || '', ev.messageId);
      continue;
    }
    if (ev.type !== 'message') continue;
    const bodyText = (ev.body || '').trim();
    if (!bodyText && ev.mediaType !== 'image') continue;

    try {
      await examService.handleInbound(ev.phone, bodyText, ev);
    } catch (err) {
      console.error(`[webhook] failed handling from ${ev.phone}:`, err.message);
      try {
        await wa.sendText(
          ev.phone,
          'Sorry, something went wrong processing your answer. Please try again.'
        );
      } catch { /* ignore */ }
    }
  }
});

module.exports = router;
