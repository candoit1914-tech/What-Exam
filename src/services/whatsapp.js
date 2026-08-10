const config = require('../config');
const db = require('../db');

const GRAPH = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 4;

// WhatsApp rejects text messages longer than 4096 characters. Keep every
// message comfortably under that cap and split longer bodies into multiple
// messages with a continuation marker.
const MAX_TEXT_LENGTH = 4000;

// The (Business Account, Consumer Account) pair rate limit (error 131056)
// drains on the order of tens of seconds, so it gets a much slower backoff
// than generic 429/5xx retries. Meta sometimes returns a retry-after header
// that is preferred when present.
const PAIR_BACKOFF_MS = [5000, 15000, 30000, 30000];
const MAX_WAIT_MS = 30000;

// Default gap between consecutive outbound messages to the SAME phone number.
// A question is delivered as several bubbles back-to-back, and a burst can
// exhaust the per-pair message window (131056). Serializing per recipient with
// a small gap keeps every burst under the limit while letting different
// students proceed in parallel. Tune via WHATSAPP_SEND_INTERVAL_MS.
const DEFAULT_SEND_INTERVAL_MS = 1200;

// Per-recipient pacing gates: phone -> Promise that resolves MIN interval
// after that phone's last outbound send settled.
const pairSlots = new Map();

function pacedSend(phone, task) {
  const prev = (pairSlots.get(phone) || Promise.resolve()).catch(() => {});
  const run = prev.then(() => task());
  const slot = run.finally(() => sleep(config.whatsapp.sendIntervalMs || DEFAULT_SEND_INTERVAL_MS));
  pairSlots.set(phone, slot);
  // The gate promise may reject (a failed send propagates through `run`). A
  // plain .then(f, f) both handles that rejection and cleans the map entry.
  slot.then(
    () => { if (pairSlots.get(phone) === slot) pairSlots.delete(phone); },
    () => { if (pairSlots.get(phone) === slot) pairSlots.delete(phone); }
  );
  return run;
}

function splitTextChunks(text, maxLen = MAX_TEXT_LENGTH) {
  const t = String(text || '');
  if (t.length <= maxLen) return [t];
  const hard = (s) => {
    const parts = [];
    while (s.length > maxLen) { parts.push(s.slice(0, maxLen)); s = s.slice(maxLen); }
    if (s) parts.push(s);
    return parts;
  };
  const chunks = [];
  let cur = '';
  for (const line of t.split('\n')) {
    for (const piece of hard(line)) {
      if (cur && cur.length + 1 + piece.length > maxLen) { chunks.push(cur); cur = ''; }
      cur = cur ? cur + '\n' + piece : piece;
      if (cur.length >= maxLen) { chunks.push(cur); cur = ''; }
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) chunks.push('');
  const marker = ' …';
  return chunks.map((c, i) => {
    if (i === chunks.length - 1) return c;
    return c.length + marker.length <= maxLen ? c + marker : c.slice(0, maxLen - marker.length) + marker;
  });
}

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
 * definitive failures (429 rate limit, the 131056 pair rate limit, 5xx), and
 * exponential backoff. Timeouts are NOT retried — the request may have been
 * delivered server-side and retrying could double-send a message.
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
    const pairLimited = code === 131056;
    const rateLimited = status === 429 || code === 130429 || code === 131029;
    const retriable = status >= 500 || rateLimited || pairLimited;

    if (retriable && attempt < attempts) {
      const retryAfter = parseInt(res.headers.get('retry-after'), 10);
      const hasRetryAfter = Number.isFinite(retryAfter) && retryAfter >= 0;
      const waitMs = pairLimited
        ? hasRetryAfter
          ? retryAfter * 1000
          : PAIR_BACKOFF_MS[attempt - 1] || PAIR_BACKOFF_MS[PAIR_BACKOFF_MS.length - 1]
        : rateLimited && hasRetryAfter
          ? retryAfter * 1000
          : backoff(attempt);
      await sleep(Math.min(waitMs, MAX_WAIT_MS));
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

function waHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.whatsapp.accessToken}`,
  };
}

async function api(method, body) {
  const task = () =>
    request(`${GRAPH}/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
      headers: waHeaders(),
      body: JSON.stringify(body),
    });
  const phone = body && body.to ? String(body.to) : '';
  return phone ? pacedSend(phone, task) : task();
}

function logOutbound(recipient, messageId, type) {
  db.prepare(
    'INSERT INTO outbound_messages (recipient, message_id, type, status) VALUES (?,?,?,?)'
  ).run(recipient, messageId || '', type, 'sent');
}

async function sendText(to, text) {
  let data;
  for (const chunk of splitTextChunks(text)) {
    data = await api('messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: chunk },
    });
    logOutbound(to, data?.messages?.[0]?.id, 'text');
  }
  return data;
}

/** Upload a PNG (buffer or file path) to the Media API, then send it as an image message. */
async function sendImage(to, image) {
  let imageBuffer;
  if (Buffer.isBuffer(image)) {
    imageBuffer = image;
  } else {
    const fs = require('fs');
    imageBuffer = fs.readFileSync(image);
  }
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
      mediaType: m.type === 'image' ? 'image' : '',
      mediaId: m.type === 'image' ? m.image?.id || '' : '',
      body:
        m.text?.body ||
        (isInteractive ? m.interactive?.button_reply?.text || m.interactive?.list_reply?.title : '') ||
        (m.type === 'image' ? m.image?.caption || '' : ''),
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

/**
 * Download inbound WhatsApp media (a student photo answer) by Graph media id.
 * GET /{mediaId} returns JSON with an expiring URL; the bytes come from the
 * second request. The access token is attached to both.
 */
async function downloadMedia(mediaId) {
  if (!mediaId) throw new Error('No media id');
  const meta = await request(`${GRAPH}/v21.0/${mediaId}`, {
    headers: waHeaders(),
    timeoutMs: 60000,
  });
  const url = meta?.url;
  if (!url) throw new Error(`WhatsApp media meta missing url: ${JSON.stringify(meta).slice(0, 200)}`);
  const res = await fetch(url, { headers: waHeaders() });
  if (!res.ok) throw new Error(`WhatsApp media download failed (${res.status})`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: meta.mime_type || '',
  };
}

module.exports = {
  waConfigured,
  splitTextChunks,
  sendText,
  sendImage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendTemplate,
  parseWebhook,
  downloadMedia,
};
