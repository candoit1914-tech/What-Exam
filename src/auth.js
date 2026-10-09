const crypto = require('crypto');
const config = require('./config');

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
const REPORT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Long enough that a figure sent today still resolves when the student opens
// the question days later; short enough that a leaked link stops working.
const FIGURE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function secret() {
  return crypto.createHash('sha256').update(String(config.admin.password) + ':what-exam:sign:v1').digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(candidate) {
  if (!config.admin.password) return false;
  return safeEqual(candidate || '', config.admin.password);
}

function signToken(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (!safeEqual(sig, expect)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function adminToken() {
  return signToken({ sub: 'admin' }, ADMIN_TTL_MS);
}

function verifyAdmin(token) {
  const p = verifyToken(token);
  return p && p.sub === 'admin' ? p : null;
}

function verifyReportToken(token, sessionId) {
  const p = verifyToken(token);
  return !!p && p.sub === 'report' && p.sid === String(sessionId);
}

function reportToken(sessionId) {
  return signToken({ sub: 'report', sid: String(sessionId) }, REPORT_TTL_MS);
}

function reportUrl(sessionId) {
  return `/report/${sessionId}?token=${encodeURIComponent(reportToken(sessionId))}`;
}

/**
 * A signed, expiring URL for ONE figure file.
 *
 * /api refuses every request without a bearer token, which is correct for the
 * dashboard and useless for WhatsApp: Meta fetches `image.link` with no
 * credentials at all. This token is what lets a figure live outside /api
 * without becoming a directory listing — it names exactly one file, and it
 * expires.
 */
function figureToken(file) {
  return signToken({ sub: 'figure', f: String(file) }, FIGURE_TTL_MS);
}

function verifyFigureToken(token, file) {
  const p = verifyToken(token);
  return !!p && p.sub === 'figure' && p.f === String(file);
}

module.exports = {
  verifyPassword, adminToken, verifyAdmin, verifyReportToken, reportUrl, reportToken,
  figureToken, verifyFigureToken, ADMIN_TTL_MS,
};
