const express = require('express');
const config = require('../config');
const wa = require('../services/whatsapp');
const db = require('../db');
const examService = require('../services/exam');

const router = express.Router();

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Verification failed');
});

router.post('/', express.json(), async (req, res) => {
  // Log every inbound POST for diagnostics (helps us see if Meta is delivering).
  try {
    db.prepare('INSERT INTO webhook_events (source, payload) VALUES (?,?)').run('inbound', JSON.stringify(req.body).slice(0, 2000));
  } catch (e) { /* non-fatal */ }
  res.status(200).send('OK'); // acknowledge immediately
  console.log('[webhook] POST', JSON.stringify(req.body).slice(0, 400));

  const events = wa.parseWebhook(req.body);
  for (const ev of events) {
    if (ev.type === 'status') {
      console.log(`[webhook] status for ${ev.messageId}: ${ev.status}${ev.error ? ' (' + ev.error + ')' : ''}`);
      db.prepare(
        `UPDATE outbound_messages SET status = ?, error = ?, updated_at = datetime('now') WHERE message_id = ?`
      ).run(ev.status, ev.error || '', ev.messageId);
      continue;
    }
    if (ev.type !== 'message') continue;
    const body = (ev.body || '').trim();
    if (!body) continue;

    try {
      await examService.handleInbound(ev.phone, body, ev);
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
