require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');

function valid(v) {
  return !!v && !/your_|example|changeme|^$/.test(v);
}

const adminPassword = (() => {
  const p = process.env.ADMIN_PASSWORD || '';
  if (valid(p)) return p;
  return 'wa-' + crypto.randomBytes(12).toString('base64url');
})();
const adminPasswordIsGenerated = !valid(process.env.ADMIN_PASSWORD || '');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  frontendPort: parseInt(process.env.FRONTEND_PORT || '8080', 10),
  frontendUrl: (process.env.FRONTEND_URL || `http://localhost:${process.env.FRONTEND_PORT || 8080}`).replace(/\/$/, ''),
  corsOrigins: (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  dbPath: path.resolve(root, process.env.DB_PATH || './data/exams.db'),
  uploadsDir: path.resolve(root, './data/uploads'),

  whatsapp: {
    accessToken: valid(process.env.WHATSAPP_ACCESS_TOKEN) ? process.env.WHATSAPP_ACCESS_TOKEN : '',
    phoneNumberId: valid(process.env.WHATSAPP_PHONE_NUMBER_ID) ? process.env.WHATSAPP_PHONE_NUMBER_ID : '',
    verifyToken: valid(process.env.WHATSAPP_VERIFY_TOKEN) ? process.env.WHATSAPP_VERIFY_TOKEN : '',
    appSecret: valid(process.env.WHATSAPP_APP_SECRET) ? process.env.WHATSAPP_APP_SECRET : '',
    templateName: (process.env.WHATSAPP_TEMPLATE_NAME || '').trim(),
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    templateParams: (process.env.WHATSAPP_TEMPLATE_PARAMS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sendIntervalMs: parseInt(process.env.WHATSAPP_SEND_INTERVAL_MS || '1200', 10),
  },

  ai: {
    baseUrl: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: valid(process.env.AI_API_KEY) ? process.env.AI_API_KEY : '',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '120000', 10),
  },

  // Optional second OpenAI-compatible provider. When configured, every AI
  // call is raced against the primary in `ai.chatJSON` and the first
  // successful response wins. Leave CLAUDE_API_KEY/CLAUDE_BASE_URL empty to
  // keep the primary as the sole provider.
  claude: {
    baseUrl: (process.env.CLAUDE_BASE_URL || '').replace(/\/$/, ''),
    apiKey: valid(process.env.CLAUDE_API_KEY) ? process.env.CLAUDE_API_KEY : '',
    model: process.env.CLAUDE_MODEL || '',
    timeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS || '0', 10),
  },

  exam: {
    passPercentage: parseFloat(process.env.PASS_PERCENTAGE || '50'),
    defaultDurationMinutes: parseInt(process.env.DEFAULT_DURATION_MINUTES || '30', 10),
    sendAnswerKey: process.env.SEND_ANSWER_KEY !== 'false',
    allowResendResults: process.env.ALLOW_RESEND_RESULTS !== 'false',
    sendConcurrency: parseInt(process.env.SEND_CONCURRENCY || '5', 10),
    sendCertificates: process.env.SEND_CERTIFICATES !== 'false',
  },

  admin: {
    password: adminPassword,
    isGenerated: adminPasswordIsGenerated,
  },

  seedOnBoot: process.env.SEED_ON_BOOT !== 'false',
};

module.exports = config;
