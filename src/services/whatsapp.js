const config = require('../config');
const db = require('../db');

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
    const err = new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.metaCode = data?.error?.error_data?.details || '';
    throw err;
  }
  return data;
}

function logOutbound(recipient, messageId, type) {
  db.prepare(
    'INSERT INTO outbound_messages (recipient, message_id, type, status) VALUES (?,?,?,?)'
  ).run(recipient, messageId || '', type, 'sent');
}

async function sendText(to, text) {
  const data = await api('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
  logOutbound(to, data?.messages?.[0]?.id, 'text');
  return data;
}

async function sendInteractiveButtons(to, text, buttons) {
  const data = await api('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons },
    },
  });
  logOutbound(to, data?.messages?.[0]?.id, 'interactive');
  return data;
}

// WhatsApp allows at most 3 reply buttons per interactive message, so a
// 4-option MCQ is split into two balanced bubbles (A·B, then C·D).
function chunkButtons(options) {
  if (options.length === 4) return [options.slice(0, 2), options.slice(2)];
  const chunks = [];
  for (let i = 0; i < options.length; i += 3) chunks.push(options.slice(i, i + 3));
  return chunks;
}

/**
 * Present an objective question's options as real WhatsApp bubble buttons.
 * Each option renders as a rounded, tappable reply chip inside the chat —
 * the native WhatsApp look for a pressable multiple-choice answer.
 * options: [{ key: 'A', text: 'Accra' }]. Button ids are the option keys so
 * the webhook resolves a tap straight to a letter (A, B, C, D).
 */
async function sendAnswerButtons(to, header, options) {
  const chunks = chunkButtons(options);
  let last;
  for (const chunk of chunks) {
    const buttons = chunk.map((o) => ({
      type: 'reply',
      reply: {
        id: String(o.key),
        title: (o.text ? `${o.key} · ${o.text}` : String(o.key)).slice(0, 20),
      },
    }));
    last = await api('messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: header ? { type: 'text', text: String(header).slice(0, 60) } : undefined,
        body: { text: 'Tap your answer. ✓' },
        action: { buttons },
      },
    });
    logOutbound(to, last?.messages?.[0]?.id, 'interactive');
  }
  return last;
}

/**
 * Interactive list message — renders tappable rows (A–D) for choosing an
 * answer. Each row: { id: 'A', title: 'Mitochondria' } (title max 24 chars).
 */
async function sendInteractiveList(to, title, body, buttonText, rows, footer) {
  const data = await api('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      footer: footer ? { text: footer } : undefined,
      action: {
        button: buttonText,
        sections: [{ title, rows }],
      },
    },
  });
  logOutbound(to, data?.messages?.[0]?.id, 'interactive');
  return data;
}

/**
 * Send an approved template as the initial touch (required by WhatsApp for
 * the first message to a user outside a 24h session window).
 * params must be [{type:'text', text:'...'}] in template order.
 */
async function sendTemplate(to, templateName, languageCode, params) {
  const data = await api('messages', {
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
  logOutbound(to, data?.messages?.[0]?.id, 'template');
  return data;
}

function parseWebhook(body) {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0]?.value;
  if (!changes) return [];
  const messages = (changes.messages || []).map((m) => {
    const isInteractive = m.type === 'interactive';
    return {
      type: 'message',
      phone: m.from,
      messageId: m.id,
      timestamp: m.timestamp,
      interactiveType: isInteractive ? m.interactive?.type || '' : '',
      replyId: isInteractive
        ? m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || ''
        : '',
      body:
        m.text?.body ||
        (isInteractive ? m.interactive?.button_reply?.text || m.interactive?.list_reply?.title : ''),
    };
  });
  const statuses = (changes.statuses || []).map((s) => ({
    type: 'status',
    phone: s.recipient_id,
    messageId: s.id,
    status: s.status,
    error: s.errors?.map((e) => `${e.code || ''} ${e.title || ''}`).join('; ') || '',
  }));
  return [...messages, ...statuses];
}

module.exports = {
  waConfigured,
  sendText,
  sendInteractiveButtons,
  sendInteractiveList,
  sendAnswerButtons,
  sendTemplate,
  parseWebhook,
};
