'use strict';

// Load before application modules: tests must never open the developer's DB,
// write to real uploads, or inherit credentials from the local .env file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'la-exam-test-'));
require('dotenv').config = () => ({ parsed: {} });
process.env.DB_PATH = path.join(root, 'exams.db');
process.env.UPLOADS_DIR = path.join(root, 'uploads');
process.env.SEED_ON_BOOT = 'false';
for (const name of Object.keys(process.env)) {
  if (/^(AI_|CLAUDE_|XAI_|PUTER_|WHATSAPP_)/.test(name)) delete process.env[name];
}
process.env.ADMIN_PASSWORD = 'isolated-test-password';
const config = require('../../src/config');
config.uploadsDir = process.env.UPLOADS_DIR;
config.ai.baseUrl = '';
config.claude.baseUrl = '';
config.xai.baseUrl = '';
fs.mkdirSync(config.uploadsDir, { recursive: true });
global.fetch = async () => { throw new Error('Unexpected network request in isolated test'); };

after(() => {
  const dbModule = require.cache[require.resolve('../../src/db')];
  if (dbModule?.exports?.open) dbModule.exports.close();
  fs.rmSync(root, { recursive: true, force: true });
});

module.exports = { root };
