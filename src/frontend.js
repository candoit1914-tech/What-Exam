const path = require('path');
const express = require('express');
const config = require('./config');

const app = express();
app.disable('x-powered-by');

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  // This URL chooses the backend database for every dashboard action. Keep it
  // fresh across frontend or API redeploys so the page cannot keep writing to
  // an old service that does not have the selected exam.
  res.set('Cache-Control', 'no-store');
  res.send(`window.API_BASE = ${JSON.stringify(config.appUrl)};`);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, name: 'la-exam-frontend' }));

if (require.main === module) {
  app.listen(config.frontendPort, '0.0.0.0', () => {
    console.log(`What Exam frontend running at http://localhost:${config.frontendPort}`);
    console.log(`Dashboard: http://localhost:${config.frontendPort} (backend: ${config.appUrl})`);
  });
}

module.exports = app;
