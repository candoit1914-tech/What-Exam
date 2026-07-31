const path = require('path');
const express = require('express');
const config = require('./config');

const app = express();

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.API_BASE = ${JSON.stringify(config.appUrl)};`);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, name: 'la-exam-frontend' }));

if (require.main === module) {
  app.listen(config.frontendPort, '0.0.0.0', () => {
    console.log(`La_Exam frontend running at http://localhost:${config.frontendPort}`);
    console.log(`Dashboard: http://localhost:${config.frontendPort} (backend: ${config.appUrl})`);
  });
}

module.exports = app;
