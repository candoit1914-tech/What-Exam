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
  res.status(200).send('OK'); // acknowledge immediately

  const events = wa.parseWebhook(req.body);
  for (const ev of events) {
    if (ev.type === 'status') {
      db.prepare(
        `UPDATE outbound_messages SET status = ?, error = ?, updated_at = datetime('now') WHERE message_id = ?`
      ).run(ev.status, ev.error || '', ev.messageId);
      continue;
    }
    if (ev.type !== 'message') continue;
    const body = (ev.body || '').trim();
    if (!body) continue;

    try {
      await examService.handleInbound(ev.phone, body);
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
