const crypto = require('crypto');
const config = require('./config');

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
const REPORT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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

module.exports = { verifyPassword, adminToken, verifyAdmin, verifyReportToken, reportUrl, reportToken, ADMIN_TTL_MS };
