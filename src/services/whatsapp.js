const config = require('../config');

const GRAPH = 'https://graph.facebook.com';

function waConfigured() {
  return !!(config.whatsapp.accessToken && config.whatsapp.phoneNumberId);
}

async function api(method, body) {
  if (!waConfigured()) throw new Error('WhatsApp is not configured. Set WHATSAPP_* vars in .env');
  const res = await fetch(`${GRAPH}/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function sendText(to, text) {
  return api('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

async function sendInteractiveButtons(to, text, buttons) {
  return api('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons },
    },
  });
}

/**
 * Send an approved template as the initial touch (required by WhatsApp for
 * the first message to a user outside a 24h session window).
 * params must be [{type:'text', text:'...'}] in template order.
 */
async function sendTemplate(to, templateName, languageCode, params) {
  return api('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || 'en' },
      components: params?.length
        ? [{ type: 'body', parameters: params }]
        : [],
    },
  });
}

function parseWebhook(body) {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0]?.value;
  if (!changes) return [];
  const messages = (changes.messages || []).map((m) => ({
    type: 'message',
    phone: m.from,
    messageId: m.id,
    timestamp: m.timestamp,
    body: m.text?.body || (m.type === 'interactive' ? m.interactive?.button_reply?.text || m.interactive?.list_reply?.title : ''),
  }));
  const statuses = (changes.statuses || []).map((s) => ({
    type: 'status',
    phone: s.recipient_id,
    messageId: s.id,
    status: s.status,
  }));
  return [...messages, ...statuses];
}

module.exports = {
  waConfigured,
  sendText,
  sendInteractiveButtons,
  sendTemplate,
  parseWebhook,
};
