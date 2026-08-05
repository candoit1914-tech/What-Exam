const config = require('../config');
const db = require('../db');

const GRAPH = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;

function waConfigured() {
  return !!(config.whatsapp.accessToken && config.whatsapp.phoneNumberId);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt) {
  return Math.pow(2, attempt - 1) * 500; // 500ms, 1s, 2s
}

/**
 * Low-level POST to the Meta Graph API with a hard timeout, retry on
 * definitive failures (429 rate limit / 5xx), and exponential backoff.
 * Timeouts are NOT retried — the request may have been delivered server-side
 * and retrying could double-send a message.
 */
async function request(url, { body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS, attempts = MAX_ATTEMPTS } = {}) {
  if (!waConfigured()) throw new Error('WhatsApp is not configured. Set WHATSAPP_* vars in .env');
  const authHeaders = { Authorization: `Bearer ${config.whatsapp.accessToken}` };
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...authHeaders, ...headers },
        body,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('WhatsApp API request timed out.');
      lastErr = err;
      if (attempt < attempts) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new Error(`WhatsApp network error: ${err.message}`);
    }
    clearTimeout(timer);

    if (res.ok) return await res.json().catch(() => ({}));

    const data = await res.json().catch(() => ({}));
    const status = res.status;
    const code = data?.error?.code;
    const rateLimited = status === 429 || code === 130429 || code === 131029;
    const retriable = status >= 500 || rateLimited;

    if (retriable && attempt < attempts) {
      const retryAfter = parseInt(res.headers.get('retry-after'), 10);
      const waitMs = rateLimited && retryAfter ? retryAfter * 1000 : backoff(attempt);
      await sleep(Math.min(waitMs, 10000));
      continue;
    }

    const err = new Error(`WhatsApp API error ${status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = status;
    err.code = code;
    err.metaCode = data?.error?.error_data?.details || '';
    throw err;
  }
  throw lastErr || new Error('WhatsApp API request failed');
}

async function api(method, body) {
  return request(`${GRAPH}/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

/** Upload a PNG buffer to the Media API, then send it as an image message. */
async function sendImage(to, imageBuffer) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/png');
  form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'certificate.png');
  const uploaded = await request(`${GRAPH}/v21.0/${config.whatsapp.phoneNumberId}/media`, {
    body: form,
    timeoutMs: 30000,
  });
  const mediaId = uploaded?.id;
  if (!mediaId) throw new Error(`WhatsApp media upload failed: ${JSON.stringify(uploaded).slice(0, 200)}`);
  const data = await api('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { id: mediaId },
  });
  logOutbound(to, data?.messages?.[0]?.id, 'image');
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
  sendImage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendTemplate,
  parseWebhook,
};
