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
  ['AI_API_KEY', 'warning', 'The primary AI provider is unavailable. AI generation, PDF extraction and grading require a usable configured provider; manually authored exams can still be delivered.', 'Set AI_API_KEY and AI_BASE_URL for the primary provider, or configure a supported alternative provider.'],
  ['CORS_ORIGIN', 'info', 'Only loopback browser origins are allowed by default. A separately hosted dashboard needs its origin allowed.', 'Set CORS_ORIGIN to the comma-separated origins of separately hosted dashboards.'],
];

function checkConfig(config = {}, env = process.env) {
  const items = CHECKS.map(([key, level, problem, fix]) => {
    const status = statusOf(env[key]);
    const generated = key === 'ADMIN_PASSWORD' && config.admin?.isGenerated;
    return status === 'set' && !generated
      ? { key, level: 'info', status, problem: 'Configured. Validity has not been verified.', fix: '' }
      : { key, level, status, problem, fix };
  });
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
