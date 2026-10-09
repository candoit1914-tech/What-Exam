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
// students proceed in parallel. 600ms: a five-bubble question lands inside
// ~3s, and the 131056 backoff still absorbs a genuine burst. Tune via
// WHATSAPP_SEND_INTERVAL_MS.
const DEFAULT_SEND_INTERVAL_MS = 600;

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

// ── Image messages ────────────────────────────────────────────────────
//
// The /media endpoint is strict and quiet about it: it takes PNG, JPEG, GIF or
// WebP up to 5 MB and answers anything else with a bare 400. The caller never
// sees that 400 as "your picture was too big" — it arrives three bubbles later
// as a student telling you the diagram never came through, while the question
// text beside it went out fine. So every figure is sniffed and normalized
// BEFORE the upload, shrunk once more if Meta still refuses, and — if the
// upload cannot be made to work at all — sent by LINK instead, which asks
// WhatsApp to fetch the bytes from our own signed URL and needs no media
// permission whatsoever.
const MEDIA_MAX_BYTES = 4 * 1024 * 1024;

/** The WhatsApp-accepted image type of these bytes, or '' when unreadable. */
function imageMediaType(buf) {
  if (!Buffer.isBuffer(buf)) return '';
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return '';
}

/**
 * Re-encode to a bounded JPEG — the format every WhatsApp client renders and
 * the /media endpoint never argues about. White, not black: a diagram drawn on
 * a transparent canvas composites onto black for JPEG, which turns a line
 * drawing into an unreadable silhouette.
 */
async function toSendableJpeg(buf) {
  const sharp = require('sharp');
  const out = await sharp(buf, { limitInputPixels: 1024 * 1024 * 512 })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return out && out.length ? out : buf;
}

async function uploadMedia(buffer, mime) {
  const form = new FormData();
  const name = mime === 'image/jpeg' ? 'figure.jpg' : mime === 'image/png' ? 'figure.png' : 'figure.img';
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), name);
  return request(`${GRAPH}/v21.0/${config.whatsapp.phoneNumberId}/media`, {
    body: form,
    timeoutMs: 30000,
  });
}

/**
 * Upload image bytes, returning the media id. Failures about the BYTES
 * (unreadable format, file too large) get one shrink-and-retry; auth, rate
 * limit and network failures are passed straight through, because re-sending
 * the same file smaller does not fix a token.
 */
async function uploadImageBuffer(buffer, mime, label) {
  try {
    const uploaded = await uploadMedia(buffer, mime);
    const id = uploaded?.id;
    if (!id) throw new Error(`WhatsApp media upload returned no id: ${JSON.stringify(uploaded).slice(0, 200)}`);
    return id;
  } catch (err) {
    if (err.status !== 400) throw err;
    let shrunk;
    try {
      shrunk = await toSendableJpeg(buffer);
    } catch {
      throw err; // the original rejection is the real reason
    }
    console.warn(`[whatsapp] media upload rejected (${err.message.slice(0, 160)}); retrying ${label} as a smaller JPEG`);
    const uploaded = await uploadMedia(shrunk, 'image/jpeg');
    const id = uploaded?.id;
    if (!id) throw new Error(`WhatsApp media upload returned no id: ${JSON.stringify(uploaded).slice(0, 200)}`);
    return id;
  }
}

/**
 * Is this a URL Meta's crawler could actually reach? WhatsApp only fetches
 * HTTPS, and a link pointing at localhost is unreachable from Meta's side — so
 * in both cases the fallback would trade a real upload error for an opaque
 * fetch failure, and the original reason is kept instead.
 */
function linkUsable(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Send an image message.
 *
 * `image` is a file path or a buffer. `opts.publicUrl` is the same picture on
 * our own server: when the media upload cannot be made to work, the message
 * goes out with `image.link` instead of `image.id`, so a Media-API problem
 * costs the student their diagram only if BOTH transports fail.
 */
async function sendImage(to, image, opts = {}) {
  const fs = require('fs');
  let buffer;
  let label;
  if (Buffer.isBuffer(image)) {
    buffer = image;
    label = 'the attached buffer';
  } else {
    label = image;
    // A file that is not there is reported as such. readFileSync's ENOENT
    // ("ENOENT: no such file or directory, open '/opt/…/1791.png'") does name
    // the path, but this says in one line what it means for the exam.
    if (!fs.existsSync(image)) throw new Error(`Figure file is missing from disk: ${image}`);
    buffer = fs.readFileSync(image);
  }
  if (!buffer || !buffer.length) throw new Error(`Figure file is empty: ${label}`);

  let mime = imageMediaType(buffer);
  if (!mime || buffer.length > MEDIA_MAX_BYTES) {
    buffer = await toSendableJpeg(buffer);
    mime = 'image/jpeg';
  }

  let mediaId = null;
  try {
    mediaId = await uploadImageBuffer(buffer, mime, label);
  } catch (err) {
    if (!opts.publicUrl || !linkUsable(opts.publicUrl)) throw err;
    console.error(`[whatsapp] media upload failed, sending ${label} by link instead: ${err.message}`);
  }

  const data = await api('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: mediaId ? { id: mediaId } : { link: opts.publicUrl },
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
      mediaType: m.type === 'image' ? 'image' : m.type === 'audio' ? 'audio' : '',
      mediaId: m.type === 'image' ? m.image?.id || '' : m.type === 'audio' ? m.audio?.id || '' : '',
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

  // Step 1: GET media metadata (requires GET, not POST)
  const metaUrl = `${GRAPH}/v21.0/${mediaId}`;
  const authHeader = { Authorization: `Bearer ${config.whatsapp.accessToken}` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let metaRes;
  try {
    metaRes = await fetch(metaUrl, {
      method: 'GET',
      headers: authHeader,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`WhatsApp media metadata request failed: ${err.message}`);
  }
  clearTimeout(timer);

  if (!metaRes.ok) {
    const errData = await metaRes.json().catch(() => ({}));
    throw new Error(`WhatsApp media metadata error ${metaRes.status}: ${JSON.stringify(errData).slice(0, 200)}`);
  }

  const meta = await metaRes.json();
  const url = meta?.url;
  if (!url) throw new Error(`WhatsApp media meta missing url: ${JSON.stringify(meta).slice(0, 200)}`);

  // Step 2: Download the actual image bytes from the expiring URL
  const imgRes = await fetch(url, { headers: authHeader });
  if (!imgRes.ok) throw new Error(`WhatsApp media download failed (${imgRes.status})`);

  return {
    buffer: Buffer.from(await imgRes.arrayBuffer()),
    mimeType: meta.mime_type || '',
  };
}

module.exports = {
  waConfigured,
  splitTextChunks,
  sendText,
  sendImage,
  imageMediaType,
  linkUsable,
  sendInteractiveButtons,
  sendInteractiveList,
  sendTemplate,
  parseWebhook,
  downloadMedia,
};
