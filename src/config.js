require('dotenv').config();
const path = require('path');

const root = path.resolve(__dirname, '..');

function valid(v) {
  return !!v && !/your_|example|changeme|^$/.test(v);
}

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
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'la_exam_verify_token',
    templateName: (process.env.WHATSAPP_TEMPLATE_NAME || '').trim(),
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    templateParams: (process.env.WHATSAPP_TEMPLATE_PARAMS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  ai: {
    baseUrl: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: valid(process.env.AI_API_KEY) ? process.env.AI_API_KEY : '',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
  },

  exam: {
    passPercentage: parseFloat(process.env.PASS_PERCENTAGE || '50'),
    defaultDurationMinutes: parseInt(process.env.DEFAULT_DURATION_MINUTES || '30', 10),
    sendAnswerKey: process.env.SEND_ANSWER_KEY !== 'false',
    allowResendResults: process.env.ALLOW_RESEND_RESULTS !== 'false',
  },

  seedOnBoot: process.env.SEED_ON_BOOT !== 'false',
};

module.exports = config;
