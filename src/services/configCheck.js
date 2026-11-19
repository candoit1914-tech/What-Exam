'use strict';

// Return status words only: callers may safely show this report in logs or the UI.
function statusOf(value) {
  if (value == null || !String(value).trim()) return 'missing';
  return /your_|example|changeme|replace_|^choose_a_strong_password$|^any_random_secret_string_you_choose$/i.test(String(value).trim()) ? 'placeholder' : 'set';
}

const CHECKS = [
  ['ADMIN_PASSWORD', 'critical', 'Without a stable admin password, a random password is generated on every boot and the operator cannot reliably sign in after restart.', 'Set ADMIN_PASSWORD to a strong, stable password in the server environment.'],
  ['WHATSAPP_APP_SECRET', 'critical', 'Webhook POSTs are rejected with 403, so student replies and delivery updates cannot be recorded.', 'Set WHATSAPP_APP_SECRET to the App secret from Meta app Settings > Basic.'],
  ['WHATSAPP_ACCESS_TOKEN', 'critical', 'Outgoing WhatsApp messages cannot be authenticated.', 'Set WHATSAPP_ACCESS_TOKEN to a valid system user access token with WhatsApp permissions.'],
  ['WHATSAPP_PHONE_NUMBER_ID', 'critical', 'Outgoing messages have no configured sending number.', 'Set WHATSAPP_PHONE_NUMBER_ID to the sending phone number ID from Meta WhatsApp API Setup.'],
  ['WHATSAPP_VERIFY_TOKEN', 'critical', 'Meta cannot verify and register the webhook without a matching verification token.', 'Set WHATSAPP_VERIFY_TOKEN to a random string and enter that same string in Meta webhook setup.'],
  ['WHATSAPP_TEMPLATE_NAME', 'critical', 'Cold recipients and recipients outside the customer service window require an approved template; free-form invitations may be rejected.', 'Set WHATSAPP_TEMPLATE_NAME to an approved template, with matching WHATSAPP_TEMPLATE_LANGUAGE and WHATSAPP_TEMPLATE_PARAMS. The recipient must reply to open the customer service window.'],
  ['WHATSAPP_PAYMENT_TEMPLATE_NAME', 'info', 'Optional WhatsApp template for sending a Paystack checkout URL to recipients outside the 24-hour WhatsApp service window. The Paystack API itself runs on the server and does not depend on this template.', 'Set WHATSAPP_PAYMENT_TEMPLATE_NAME only if paid exam checkout links must be sent to cold WhatsApp recipients.'],
  ['WHATSAPP_PAID_START_TEMPLATE_NAME', 'info', 'Optional WhatsApp template for starting a paid exam outside the 24-hour WhatsApp service window. Paystack payment confirmation does not depend on this template.', 'Set WHATSAPP_PAID_START_TEMPLATE_NAME only if paid exams must start by WhatsApp template when the service window is closed.'],
  // Payments are opt-in: .env.example tells operators to leave the key blank
  // until they price a paper, so a missing key warns instead of declaring an
  // otherwise working deployment broken.
  ['PAYSTACK_SECRET_KEY', 'warning', 'Priced exams cannot be created: checkouts cannot be initialized, references cannot be verified and webhook signatures cannot be checked. Free exams are unaffected.', 'Set PAYSTACK_SECRET_KEY from the Paystack dashboard (API Keys & Webhooks) when you price a paper, and keep it private.'],
  ['CORS_ORIGIN', 'info', 'Loopback and the deployed dashboard (what-exam.vercel.app) are allowed by default. Any OTHER separately hosted dashboard is refused — its calls fail as "Failed to fetch".', 'Set CORS_ORIGIN to the comma-separated origins of any additional separately hosted dashboards.'],
];

function checkConfig(config = {}, env = process.env) {
  const items = CHECKS.map(([key, level, problem, fix]) => {
    const status = statusOf(env[key]);
    const generated = key === 'ADMIN_PASSWORD' && config.admin?.isGenerated;
    return status === 'set' && !generated
      ? { key, level: 'info', status, problem: 'Configured. Validity has not been verified.', fix: '' }
      : { key, level, status, problem, fix };
  });
  const explicitProvider = String(env.AI_PROVIDER || '').trim().toLowerCase();
  const openaiKeyStatus = statusOf(env.OPENAI_API_KEY);
  // Mirror src/config.js: a legacy gateway deployment (AI_BASE_URL + AI_API_KEY,
  // no OPENAI_API_KEY) really is configured and must not be reported as broken.
  const legacyGatewayReady = statusOf(env.AI_API_KEY) === 'set' && statusOf(env.AI_BASE_URL) === 'set';
  const openaiPrimary = explicitProvider !== 'compatible'
    && !(legacyGatewayReady && openaiKeyStatus !== 'set');
  const primaryKey = openaiPrimary ? 'OPENAI_API_KEY' : 'AI_API_KEY';
  const primaryStatus = statusOf(env[primaryKey]);
  const primaryConfigured = openaiPrimary || statusOf(env.AI_BASE_URL) === 'set';
  const aiStatus = primaryConfigured ? primaryStatus : 'missing';
  const aiReady = aiStatus === 'set';
  items.push({
    key: primaryKey,
    level: aiReady ? 'info' : 'warning',
    status: aiStatus,
    problem: aiReady
      ? 'Configured. Validity and API billing have not been verified.'
      : 'AI exam generation, PDF extraction and automatic grading need the primary AI provider configured.',
    fix: aiReady ? '' : openaiPrimary
      ? 'Set OPENAI_API_KEY to an API key from the OpenAI platform. Keep it private; ChatGPT subscription access does not provide this API key.'
      : 'Set AI_API_KEY and AI_BASE_URL for the compatible primary provider, or set AI_PROVIDER=openai and configure OPENAI_API_KEY.',
  });
  if (!openaiPrimary) {
    const status = statusOf(env.OPENAI_API_KEY);
    items.push(status === 'set'
      ? { key: 'OPENAI_API_KEY', level: 'info', status, problem: 'Configured. Validity has not been verified.', fix: '' }
      : { key: 'OPENAI_API_KEY', level: 'warning', status,
        problem: 'Voice notes cannot be transcribed (unless AI_TRANSCRIBE_API_KEY is set) and photo answers use OCR only.',
        fix: 'Set OPENAI_API_KEY to enable OpenAI Whisper transcription and vision reading for photos.' });
  }
  const status = statusOf(config.appUrl);
  let publicUrl = false;
  try {
    const url = new URL(config.appUrl);
    publicUrl = status === 'set' && url.protocol === 'https:' && !url.username && !url.password &&
      !['localhost', '[::1]', '0.0.0.0'].includes(url.hostname) && !/^127\./.test(url.hostname) && !url.hostname.endsWith('.localhost');
  } catch { /* Malformed URLs get the same redacted finding. */ }
  items.push({ key: 'APP_URL', level: publicUrl ? 'info' : 'warning', status,
    problem: publicUrl ? 'Configured. Public reachability has not been verified.' : 'Report links and the displayed webhook URL need a public HTTPS address; localhost, malformed or insecure URLs are unsuitable for students.',
    fix: publicUrl ? '' : 'Set APP_URL to the public HTTPS address of this backend without credentials or a trailing slash.' });
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const item of items) counts[item.level]++;
  return { ok: counts.critical === 0, counts, items };
}

module.exports = { checkConfig, statusOf };
