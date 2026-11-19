const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const wa = require('../services/whatsapp');
const db = require('../db');
const examService = require('../services/exam');

const router = express.Router();

function shouldProcessInbound(ev, bodyText = (ev && ev.body || '').trim()) {
  return Boolean(bodyText || ev?.replyId || ev?.mediaType === 'image' || ev?.mediaType === 'audio');
}

// Warned once per boot that unsigned webhook POSTs are being accepted
// (WHATSAPP_APP_SECRET unset). Repeating it per event would drown the logs.
let warnedUnsigned = false;

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Meta can deliver status callbacks out of order (for example `delivered`
// immediately before an older `sent` callback). Keep the most advanced state
// so the app's delivery ticks never move backwards.
const OUTBOUND_STATUS_RANK = { sent: 1, failed: 2, delivered: 3, read: 4 };

function recordOutboundStatus(event) {
  const messageId = String(event.messageId || '').trim();
  const nextStatus = String(event.status || '').toLowerCase();
  const nextRank = OUTBOUND_STATUS_RANK[nextStatus];
  if (!messageId || !nextRank) return;

  const existing = db.prepare(
    'SELECT id, status FROM outbound_messages WHERE message_id = ? ORDER BY id DESC LIMIT 1'
  ).get(messageId);
  if (!existing) {
    // The callback can win the race against the send request returning. Store
    // it now; whatsapp.logOutbound() will fill in the real message type later.
    db.prepare(
      `INSERT INTO outbound_messages (recipient, message_id, type, status, error, updated_at)
       VALUES (?, ?, 'unknown', ?, ?, datetime('now'))`
    ).run(event.phone || '', messageId, nextStatus, nextStatus === 'failed' ? event.error || '' : '');
    return;
  }

  const currentRank = OUTBOUND_STATUS_RANK[String(existing.status || '').toLowerCase()] || 0;
  if (nextRank <= currentRank) return;
  db.prepare(
    `UPDATE outbound_messages
        SET status = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(nextStatus, nextStatus === 'failed' ? event.error || '' : '', existing.id);
}

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (!config.whatsapp.verifyToken) {
    console.error('[webhook] WHATSAPP_VERIFY_TOKEN not configured — refusing verification');
    return res.status(403).send('Verification failed');
  }
  const tokenOk = (() => {
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(String(config.whatsapp.verifyToken));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  })();
  if (mode === 'subscribe' && tokenOk) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Verification failed');
});

router.post('/', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  if (config.whatsapp.appSecret) {
    const signature = String(req.headers['x-hub-signature-256'] || '');
    const expected = signature.startsWith('sha256=') ? signature.slice(7) : '';
    const computed = crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.body || Buffer.alloc(0)).digest('hex');
    if (!expected || !timingSafeEqualHex(computed, expected)) {
      console.warn('[webhook] signature mismatch — rejecting spoofed webhook event');
      return res.status(403).send('Signature verification failed');
    }
  } else {
    // Unsigned mode. The alternative — rejecting every POST — made the bot
    // DEAF: Meta delivered each student reply, was answered 403, retried for a
    // while and then gave up, so no exam ever opened and no question ever
    // moved, with nothing in the logs past one line at boot. Accepting keeps
    // the exam running; the loud warning (once per boot) names the cost —
    // student replies cannot be authenticated, so a forged webhook event is
    // possible until the secret is set.
    if (!warnedUnsigned) {
      warnedUnsigned = true;
      console.warn('[webhook] WHATSAPP_APP_SECRET not configured — accepting UNSIGNED webhook POSTs (spoofing possible). Set the App secret from Meta app Settings > Basic to verify student replies.');
    }
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    return res.status(400).send('Invalid JSON payload');
  }

  const events = wa.parseWebhook(body);
  const statuses = events.filter((event) => event.type === 'status');
  const inbound = events.filter((event) => {
    if (event.type !== 'message') return false;
    return shouldProcessInbound(event, (event.body || '').trim());
  });

  // Record only event metadata. The previous raw-payload log included phone
  // numbers, profile names, answers and interactive payloads in Render logs.
  const eventSummary = events.map((event) => event.type === 'status'
    ? { type: 'status', status: event.status, hasError: !!event.error }
    : {
      type: 'message',
      interactiveType: event.interactiveType || '',
      mediaType: event.mediaType || '',
      hasReply: !!event.replyId,
      hasText: !!String(event.body || '').trim(),
    });
  try {
    db.prepare('INSERT INTO webhook_events (source, payload) VALUES (?,?)')
      .run('inbound', JSON.stringify(eventSummary).slice(0, 2000));
  } catch (e) { /* non-fatal */ }

  // Acknowledge Meta before doing exam work. Statuses are applied immediately,
  // then independent recipients can advance in parallel; handleInbound keeps
  // each individual WhatsApp number serialized and in order.
  res.status(200).send('OK');
  console.log(`[webhook] batch received: ${inbound.length} message(s), ${statuses.length} status update(s)`);

  for (const event of statuses) recordOutboundStatus(event);

  await Promise.all(inbound.map(async (event) => {
    const bodyText = (event.body || '').trim();
    try {
      await examService.handleInbound(event.phone, bodyText, event);
    } catch (err) {
      console.error(`[webhook] message processing failed (type=${event.interactiveType || event.mediaType || 'text'}):`, err.message);
      try {
        await wa.sendText(
          event.phone,
          'Sorry, something went wrong processing your answer. Please try again.'
        );
      } catch { /* ignore */ }
    }
  }));
});

module.exports = router;
module.exports.shouldProcessInbound = shouldProcessInbound;
module.exports.recordOutboundStatus = recordOutboundStatus;
