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

const API_ENDPOINTS = [
  ['GET', '/api/stats', 'Dashboard summary counts'],
  ['GET', '/api/exams', 'List exams'],
  ['POST', '/api/exams', 'Create an exam'],
  ['GET', '/api/exams/:id', 'Exam detail (questions, recipients, results)'],
  ['PATCH', '/api/exams/:id', 'Update exam meta'],
  ['POST', '/api/exams/:id/publish', 'Publish (make live)'],
  ['POST', '/api/exams/:id/end', 'End a live exam'],
  ['POST', '/api/exams/:id/archive', 'Archive an exam'],
  ['DELETE', '/api/exams/:id', 'Delete an exam'],
  ['POST', '/api/exams/:id/recipients', 'Add recipient phones'],
  ['DELETE', '/api/exams/:id/recipients/:studentId', 'Remove a recipient'],
  ['POST', '/api/exams/:id/send', 'Send exam to recipients via WhatsApp'],
  ['POST', '/api/exams/:id/questions', 'Add a question'],
  ['PUT', '/api/exams/:id/questions/:qid', 'Update a question'],
  ['DELETE', '/api/exams/:id/questions/:qid', 'Delete a question'],
  ['PUT', '/api/exams/:id/scheme/:qid', 'Edit a marking scheme (JSON)'],
  ['POST', '/api/exams/:id/scheme/:qid/generate', 'Regenerate scheme with AI'],
  ['POST', '/api/exams/:id/generate', 'AI-generate questions'],
  ['POST', '/api/exams/:id/pdf', 'Extract questions from uploaded PDF'],
  ['GET', '/api/results', 'Completed sessions'],
  ['GET', '/api/results/:sessionId', 'Session detail + answers'],
  ['PATCH', '/api/results/:sessionId/answers/:answerId', 'Adjust awarded marks'],
  ['POST', '/api/results/:sessionId/resend', 'Resend result via WhatsApp'],
  ['GET', '/api/students', 'List students'],
  ['PATCH', '/api/students/:id', 'Rename a student'],
  ['GET', '/report/:sessionId', 'Printable HTML report for a session'],
  ['GET', '/webhook/whatsapp', 'WhatsApp webhook verification (GET)'],
  ['POST', '/webhook/whatsapp', 'WhatsApp webhook events'],
  ['GET', '/health', 'Health check'],
];

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>La_Exam API</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#222}
  h1{font-size:22px} h2{font-size:15px;color:#666;font-weight:500;margin:4px 0 24px}
  code{background:#f1f3f5;padding:2px 6px;border-radius:4px;font-size:13px}
  table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e9ecef;font-size:13px}
  th{color:#666;font-weight:600} .m{color:#666}
  a{color:#0b57d0;text-decoration:none}
</style></head><body>
<h1>La_Exam API</h1>
<h2>Backend server &mdash; JSON API, WhatsApp webhook, and reports. Admin dashboard: <a href="http://localhost:${config.frontendPort}">http://localhost:${config.frontendPort}</a></h2>
<table><thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead><tbody>
${API_ENDPOINTS.map(([m, p, d]) => `<tr><td><code>${m}</code></td><td><code>${p}</code></td><td class="m">${d}</td></tr>`).join('')}
</tbody></table></body></html>`);
});

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => res.json({ allowed_origins: [] }));

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
      console.log(`La_Exam admin running at http://localhost:${config.port}`);
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
