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
  uploadsDir: path.resolve(root, process.env.UPLOADS_DIR || './data/uploads'),

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
    sendIntervalMs: parseInt(process.env.WHATSAPP_SEND_INTERVAL_MS || '2000', 10),
  },

  ai: {
    // AshnaAI is a multi-model gateway that speaks the OpenAI chat-completions
    // contract, so switching the primary provider is a base-URL change, not a
    // code change. Point AI_BASE_URL/AI_MODEL at any OpenAI-compatible host to
    // trade quality for cost.
    baseUrl: (process.env.AI_BASE_URL || 'https://api.ashna.ai/v1/api').replace(/\/$/, ''),
    apiKey: valid(process.env.AI_API_KEY) ? process.env.AI_API_KEY : '',
    // gpt-6-astra is a reasoning-family flagship, and the most expensive tier
    // the gateway offers: a single paper costs ~80 AI calls, so per-call price
    // dominates the bill. It is the default because it is the quality ceiling
    // for hard papers; drop AI_MODEL to a cheaper catalog id (gpt-5-mini,
    // glm-5.3-flash) when volume, not quality, is the constraint.
    defaultModel: 'gpt-6-astra',
    model: process.env.AI_MODEL || 'gpt-6-astra',
    // 'none' skips reasoning tokens entirely, which is the dominant latency
    // and cost term at this call volume - but gpt-6-astra rejects 'none' with a
    // 400, so it cannot be the default. 'low' is the cheapest effort astra
    // accepts. Raise to 'medium'/'high' if extraction quality on a hard paper
    // needs it. Set AI_REASONING_EFFORT='' to omit the field entirely.
    defaultReasoningEffort: 'low',
    reasoningEffort: process.env.AI_REASONING_EFFORT !== undefined
      ? process.env.AI_REASONING_EFFORT
      : 'low',
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '120000', 10),
    // Per-block budget for PDF question extraction. This is deliberately much
    // larger than timeoutMs: a block that overruns is not retried into
    // oblivion, it is SKIPPED, so a tight budget silently deletes questions.
    // Measured on a real 17-page paper: blocks took 28s-89s to answer. The
    // default carries extra headroom for a flagship reasoning model behind a
    // gateway, which is slower than the host the range was measured on.
    blockTimeoutMs: parseInt(process.env.AI_BLOCK_TIMEOUT_MS || '360000', 10),
    vision: process.env.AI_VISION === 'true',
  },

  // Optional second OpenAI-compatible provider. The primary is the main AI:
  // it is called on its own, and this endpoint is only tried if the primary
  // fails (see `ai.chatJSON`). Leave CLAUDE_API_KEY/CLAUDE_BASE_URL empty to
  // keep the primary as the sole provider.
  claude: {
    baseUrl: (process.env.CLAUDE_BASE_URL || '').replace(/\/$/, ''),
    apiKey: valid(process.env.CLAUDE_API_KEY) ? process.env.CLAUDE_API_KEY : '',
    model: process.env.CLAUDE_MODEL || '',
    timeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS || '0', 10),
  },

  // Optional third OpenAI-compatible provider (xAI / Grok). A last-resort
  // fallback, tried only after the primary and secondary have both failed.
  // Leave empty to skip.
  xai: {
    baseUrl: (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/$/, ''),
    apiKey: valid(process.env.XAI_API_KEY) ? process.env.XAI_API_KEY : '',
    model: process.env.XAI_MODEL || 'grok-3',
    timeoutMs: parseInt(process.env.XAI_TIMEOUT_MS || '0', 10),
  },

  exam: {
    passPercentage: parseFloat(process.env.PASS_PERCENTAGE || '50'),
    defaultDurationMinutes: parseInt(process.env.DEFAULT_DURATION_MINUTES || '30', 10),
    sendAnswerKey: process.env.SEND_ANSWER_KEY !== 'false',
    allowResendResults: process.env.ALLOW_RESEND_RESULTS !== 'false',
    sendConcurrency: parseInt(process.env.SEND_CONCURRENCY || '2', 10),
    sendCertificates: process.env.SEND_CERTIFICATES !== 'false',
    sendRetries: parseInt(process.env.SEND_RETRIES || '3', 10),
    sendRetryDelayMs: parseInt(process.env.SEND_RETRY_DELAY_MS || '5000', 10),
    staleSessionCleanupIntervalMs: parseInt(process.env.STALE_SESSION_CLEANUP_MS || '60000', 10),
    // Global cap on attempts per student per exam. 0 = unlimited.
    // An individual exam's max_attempts column overrides this.
    maxAttempts: parseInt(process.env.MAX_ATTEMPTS || '0', 10) || 0,
  },

  puter: {
    apiKey: process.env.PUTER_API_KEY || '',
  },

  admin: {
    password: adminPassword,
    isGenerated: adminPasswordIsGenerated,
  },

  seedOnBoot: process.env.SEED_ON_BOOT !== 'false',
};

module.exports = config;
