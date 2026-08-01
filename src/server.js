const express = require('express');
const config = require('./config');
const api = require('./routes/api');
const webhook = require('./routes/webhook');
const results = require('./services/results');

const app = express();
app.use(express.json());

function originAllowed(origin) {
  if (config.corsOrigins.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', api);
app.use('/webhook/whatsapp', webhook);
app.get('/report/:sessionId', (req, res) => {
  const r = results.reportHTML(req.params.sessionId);
  res.status(r.status).send(r.html);
});

const API_GROUPS = [
  ['System', [
    ['GET', '/health', 'Health check'],
    ['GET', '/api/stats', 'Dashboard summary counts'],
  ]],
  ['Exams', [
    ['GET', '/api/exams', 'List exams'],
    ['POST', '/api/exams', 'Create an exam'],
    ['GET', '/api/exams/:id', 'Exam detail (questions, recipients, results)'],
    ['PATCH', '/api/exams/:id', 'Update exam meta'],
    ['DELETE', '/api/exams/:id', 'Delete an exam'],
    ['POST', '/api/exams/:id/publish', 'Publish (make live)'],
    ['POST', '/api/exams/:id/end', 'End a live exam'],
    ['POST', '/api/exams/:id/archive', 'Archive an exam'],
  ]],
  ['Recipients & Delivery', [
    ['POST', '/api/exams/:id/recipients', 'Add recipient phones'],
    ['DELETE', '/api/exams/:id/recipients/:studentId', 'Remove a recipient'],
    ['POST', '/api/exams/:id/send', 'Send exam to recipients via WhatsApp'],
  ]],
  ['Questions & Schemes', [
    ['POST', '/api/exams/:id/questions', 'Add a question'],
    ['PUT', '/api/exams/:id/questions/:qid', 'Update a question'],
    ['DELETE', '/api/exams/:id/questions/:qid', 'Delete a question'],
    ['PUT', '/api/exams/:id/scheme/:qid', 'Edit a marking scheme (JSON)'],
    ['POST', '/api/exams/:id/scheme/:qid/generate', 'Regenerate scheme with AI'],
  ]],
  ['AI & Files', [
    ['POST', '/api/exams/:id/generate', 'AI-generate questions'],
    ['POST', '/api/exams/:id/pdf', 'Extract questions from uploaded PDF'],
  ]],
  ['Results & Students', [
    ['GET', '/api/results', 'Completed sessions'],
    ['GET', '/api/results/:sessionId', 'Session detail + answers'],
    ['PATCH', '/api/results/:sessionId/answers/:answerId', 'Adjust awarded marks'],
    ['POST', '/api/results/:sessionId/resend', 'Resend result via WhatsApp'],
    ['GET', '/api/students', 'List students'],
    ['PATCH', '/api/students/:id', 'Rename a student'],
  ]],
  ['Reports & WhatsApp', [
    ['GET', '/report/:sessionId', 'Printable HTML report for a session'],
    ['GET', '/webhook/whatsapp', 'WhatsApp webhook verification (GET)'],
    ['POST', '/webhook/whatsapp', 'WhatsApp webhook events'],
  ]],
];

function methodClass(m) {
  return m === 'GET' ? 'get' : m === 'POST' ? 'post' : m === 'PUT' || m === 'PATCH' ? 'put' : 'del';
}

function endpointLink(m, p) {
  if (m === 'GET' && !p.includes(':')) {
    return `<a href="${p}" target="_blank" rel="noopener"><code>${p}</code></a>`;
  }
  return `<code>${p}</code>`;
}

app.get('/', (req, res) => {
  const wa = config.whatsapp.accessToken ? 'on' : 'off';
  const ai = config.ai.apiKey ? 'on' : 'off';
  const rows = API_GROUPS.map(
    ([group, eps]) => `
      <h2 class="group">${group}</h2>
      <table><tbody>
        ${eps
          .map(
            ([m, p, d]) => `<tr>
              <td class="m"><span class="method ${methodClass(m)}">${m}</span></td>
              <td>${endpointLink(m, p)}</td>
              <td class="m">${d}</td>
            </tr>`
          )
          .join('')}
      </tbody></table>`
  ).join('');
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>La_Exam API</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--line:#334155;--fg:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8}
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;min-height:100vh}
  .wrap{max-width:900px;margin:0 auto;padding:32px 20px 64px}
  header{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;margin-bottom:8px}
  h1{font-size:24px;margin:0}
  .sub{color:var(--muted);margin:6px 0 0}
  .badges{display:flex;gap:8px;flex-wrap:wrap}
  .badge{padding:5px 12px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--line)}
  .badge.on{background:#14532d;color:#86efac;border-color:#166534}
  .badge.off{background:#7f1d1d;color:#fca5a5;border-color:#991b1b}
  .group{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin:28px 0 8px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  td{padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .m{color:var(--muted);white-space:nowrap}
  code{background:#0b1220;padding:2px 7px;border-radius:6px;font-size:12px;color:#e2e8f0}
  a{color:var(--accent);text-decoration:none}
  a code{color:var(--accent)}
  .method{display:inline-block;min-width:52px;text-align:center;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700}
  .method.get{background:#0f3d2e;color:#4ade80}
  .method.post{background:#1e3a8a;color:#93c5fd}
  .method.put{background:#78350f;color:#fbbf24}
  .method.del{background:#7f1d1d;color:#f87171}
  footer{margin-top:32px;color:var(--muted);font-size:12px;display:flex;gap:16px;flex-wrap:wrap}
  @media(max-width:640px){td{white-space:normal} .m{white-space:nowrap}}
</style></head><body><div class="wrap">
<header>
  <div>
    <h1>What Exam API</h1>
    <p class="sub">Backend server &mdash; JSON API, WhatsApp webhook, and reports</p>
  </div>
  <div class="badges">
    <span class="badge ${wa}">WhatsApp ${wa === 'on' ? 'configured' : 'not configured'}</span>
    <span class="badge ${ai}">AI ${ai === 'on' ? `configured (${config.ai.model})` : 'not configured'}</span>
  </div>
</header>
<p class="sub">Admin dashboard: <a href="${config.frontendUrl}">${config.frontendUrl}</a> &middot; Webhook: <code>${config.appUrl}/webhook/whatsapp</code></p>
${rows}
<footer>
  <span>What Exam v1.0.0</span>
  <a href="${config.frontendUrl}">Dashboard</a>
  <a href="/health">Health</a>
</footer>
</div></body></html>`);
});

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => res.json({ allowed_origins: [] }));

app.get('/privacy', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Privacy Policy — La_Exam</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--line:#334155;--fg:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8}
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;line-height:1.65}
  .wrap{max-width:760px;margin:0 auto;padding:40px 20px 64px}
  h1{font-size:24px;margin:0 0 4px}
  .sub{color:var(--muted);margin:0 0 28px}
  h2{font-size:16px;color:var(--accent);margin:24px 0 8px}
  p{color:var(--fg);margin:6px 0}
  a{color:var(--accent)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-top:8px}
  footer{margin-top:40px;color:var(--muted);font-size:12px}
</style></head><body><div class="wrap">
<h1>Privacy Policy</h1>
<p class="sub">What Exam — last updated August 2026</p>

<div class="card">
<h2>1. Data we collect</h2>
<p>What Exam collects the information needed to run WhatsApp-based examinations: student name, WhatsApp phone number, exam responses, and exam results. We do not collect more personal data than is necessary for the service.</p>

<h2>2. How we use your data</h2>
<p>Your phone number is used solely to deliver exams and results to you over WhatsApp. Your responses are used to mark exams and produce results. No data is sold or shared with third parties for marketing.</p>

<h2>3. Data storage</h2>
<p>Data is stored on secure servers operated by the service provider (Render). We take reasonable measures to protect your information, but no method of transmission or storage is 100% secure.</p>

<h2>4. WhatsApp</h2>
<p>This service uses the WhatsApp Business Platform. By using the service you agree to WhatsApp's Terms of Service and acknowledge that message delivery is handled by WhatsApp/Meta.</p>

<h2>5. Data retention &amp; deletion</h2>
<p>Data is kept for as long as needed to administer exams. To request deletion of your data, contact the administrator of the school or institution that issued your exam.</p>

<h2>6. Contact</h2>
<p>For privacy questions, contact the institution administrator that provided this exam.</p>
</div>

<footer><a href="/">← Back to API</a> · What Exam</footer>
</div></body></html>`);
});

app.get('/health', (req, res) => res.json({ ok: true, appUrl: config.appUrl }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

if (require.main === module) {
  const run = async () => {
    if (process.argv.includes('--init')) {
      const db = require('./db');
      console.log('Database initialised at', config.dbPath);
      return;
    }
    app.listen(config.port, '0.0.0.0', () => {
      console.log(`What Exam admin running at http://localhost:${config.port}`);
      console.log(`Webhook URL for WhatsApp: ${config.appUrl}/webhook/whatsapp`);
      console.log(
        config.whatsapp.accessToken
          ? 'WhatsApp: configured ✓'
          : 'WhatsApp: NOT configured (set WHATSAPP_* in .env)'
      );
      console.log(
        config.ai.apiKey
          ? `AI: configured (${config.ai.model}) ✓`
          : 'AI: NOT configured (set AI_API_KEY/AI_BASE_URL in .env)'
      );
    });
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = app;
