# Configuration Self-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator can tell, before an exam is sent, exactly which settings are missing and what breaks because of them — without ever printing a secret.

**Architecture:** A pure function `checkConfig(config, env)` in a new `src/services/configCheck.js` returns a structured report of `critical | warning | info` items, each with the offending `key`, a plain-language consequence and the concrete fix. It is the single source of truth behind three consumers: a boot banner in `src/server.js`, a `GET /api/config-check` route for the dashboard, and a `node scripts/config-check.js` CLI. The function never returns a secret value — only `set`, `placeholder` or `missing`.

**Tech Stack:** Node.js >= 22.5, CommonJS, `node:test` + `node:assert/strict`.

## Why This Is First

`src/server.js:291-294` already warns about `WHATSAPP_APP_SECRET`, but nothing warns about `WHATSAPP_TEMPLATE_NAME`, and the checks are scattered `console.warn` calls with no endpoint and no CLI. The live `.env` in this project is missing three settings that each break a different part of an exam:

| Missing key | Consequence, in the order a live exam hits them |
|---|---|
| `ADMIN_PASSWORD` | `src/config.js:11-16` generates a random password **on every boot**. The operator cannot log back in after a redeploy. |
| `WHATSAPP_APP_SECRET` | `src/routes/webhook.js` returns 403 before parsing the body, so **no student reply is ever recorded**. Every session looks `didnt_start`. |
| `WHATSAPP_TEMPLATE_NAME` | `src/config.js:36` falls back to free-form delivery. Meta rejects it for any number that has never messaged the business (error 131026), so the exam never reaches cold recipients. |

Each of these fails silently. This plan makes them loud.

## Global Constraints

- **Never log a secret value.** The report exposes only a status word. A test asserts that no check message contains any substring of a supplied secret.
- `valid()` in `src/config.js:7-9` already treats `your_*`, `*example*`, `*changeme*` and empty as unset. Reuse the same idea so a copied `.env.example` is reported as `placeholder`, not `set`.
- Checks read `process.env` for keys that `config.js` deliberately discards (a placeholder token becomes `''` in config), so the checker must see the raw env, not the sanitised config.
- Adding the check must not change runtime behaviour when everything is configured. It is read-only.
- No new dependencies.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/services/configCheck.js` | `checkConfig(config, env) -> report` — the only source of truth |
| `scripts/config-check.js` | CLI wrapper; prints the report and exits non-zero on critical |
| `src/routes/api.js` | `GET /api/config-check` adapter |
| `src/server.js` | Replace scattered `console.warn` boot checks with the report |
| `test/config-check.test.js` | All tests |
| `.env.example` | Document the tuning keys that are missing today |
| `package.json` | Register the test file and a `config:check` script |

A new file rather than more code in `config.js`: `config.js` is imported by every module at require time, and it must stay a pure value object. Putting a report builder there would make it harder to test in isolation and would risk a circular import with `server.js`.

---

## Task 1: `checkConfig` — severity model and secret redaction

**Files:**
- Create: `src/services/configCheck.js`
- Create: `test/config-check.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```js
  checkConfig(config, env = process.env) -> {
    ok: boolean,                 // true when no item is 'critical'
    counts: { critical, warning, info },
    items: Array<{
      level: 'critical' | 'warning' | 'info',
      key: string,               // the env var name, or a pseudo-key like 'webhook'
      status: 'set' | 'placeholder' | 'missing' | 'n/a',
      problem: string,           // what breaks
      fix: string                // the concrete action
    }>
  }
  ```
  Exported as `{ checkConfig, statusOf }`.

- [ ] **Step 1: Write the failing test file**

Create `test/config-check.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkConfig, statusOf } = require('../src/services/configCheck');

// A config object with everything present, so each test can delete exactly
// one key and assert on that one finding. The app URL deliberately avoids the
// substring 'example', which statusOf treats as a placeholder — otherwise this
// "fully configured" fixture would itself report a warning.
const FULL = {
  appUrl: 'https://exam.whaexam.org',
  whatsapp: {
    accessToken: 'EAAG-real',
    phoneNumberId: '1234567890',
    verifyToken: 'verify-me',
    appSecret: 'SUPER-SECRET-APP-SECRET',
    templateName: 'exam_invite',
  },
  ai: { apiKey: 'sk-live', model: 'gpt-4o-mini' },
  admin: { isGenerated: false },
  corsOrigins: ['https://admin.whaexam.org'],
};

const FULL_ENV = {
  ADMIN_PASSWORD: 'a-strong-password',
  WHATSAPP_APP_SECRET: 'SUPER-SECRET-APP-SECRET',
  WHATSAPP_TEMPLATE_NAME: 'exam_invite',
  WHATSAPP_ACCESS_TOKEN: 'EAAG-real',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_VERIFY_TOKEN: 'verify-me',
  AI_API_KEY: 'sk-live',
  CORS_ORIGIN: 'https://admin.whaexam.org',
};

const clone = () => JSON.parse(JSON.stringify(FULL));
const cloneEnv = () => ({ ...FULL_ENV });
const find = (report, key) => report.items.find((i) => i.key === key);

test('a fully configured system reports ok with nothing to warn about', () => {
  const r = checkConfig(clone(), cloneEnv());
  assert.equal(r.ok, true, JSON.stringify(r.items.filter((i) => i.level === 'critical'), null, 2));
  assert.equal(r.counts.critical, 0);
  assert.equal(r.counts.warning, 0);
});

test('statusOf classifies set, placeholder and missing without echoing the value', () => {
  assert.equal(statusOf('a-real-value'), 'set');
  assert.equal(statusOf('your_meta_app_secret'), 'placeholder');
  assert.equal(statusOf('changeme'), 'placeholder');
  assert.equal(statusOf('https://example.com'), 'placeholder');
  assert.equal(statusOf(''), 'missing');
  assert.equal(statusOf(undefined), 'missing');
  assert.equal(statusOf(null), 'missing');
  assert.equal(statusOf('   '), 'missing');
});

test('a missing app secret is critical and names the symptom', () => {
  const env = cloneEnv();
  delete env.WHATSAPP_APP_SECRET;
  const r = checkConfig(clone(), env);
  const item = find(r, 'WHATSAPP_APP_SECRET');
  assert.ok(item, 'the missing key must be reported');
  assert.equal(item.level, 'critical');
  assert.equal(item.status, 'missing');
  assert.match(item.problem, /403|reject/i);
  assert.match(item.problem, /answer|reply/i);
  assert.equal(r.ok, false);
});

test('a placeholder app secret is critical too, not treated as configured', () => {
  const env = cloneEnv();
  env.WHATSAPP_APP_SECRET = 'your_meta_app_secret';
  const r = checkConfig(clone(), env);
  const item = find(r, 'WHATSAPP_APP_SECRET');
  assert.equal(item.level, 'critical');
  assert.equal(item.status, 'placeholder');
});

test('a missing template name is critical for cold recipients', () => {
  const env = cloneEnv();
  delete env.WHATSAPP_TEMPLATE_NAME;
  const cfg = clone();
  cfg.whatsapp.templateName = '';
  const r = checkConfig(cfg, env);
  const item = find(r, 'WHATSAPP_TEMPLATE_NAME');
  assert.equal(item.level, 'critical');
  assert.match(item.problem, /131026|cold|never messaged/i);
  assert.match(item.fix, /template/i);
});

test('a generated admin password is critical and explains it resets each boot', () => {
  const cfg = clone();
  cfg.admin.isGenerated = true;
  const env = cloneEnv();
  delete env.ADMIN_PASSWORD;
  const r = checkConfig(cfg, env);
  const item = find(r, 'ADMIN_PASSWORD');
  assert.equal(item.level, 'critical');
  assert.match(item.problem, /every boot|random/i);
  assert.match(item.fix, /ADMIN_PASSWORD/);
});

test('APP_URL pointing at localhost on a public host is a warning', () => {
  const cfg = clone();
  cfg.appUrl = 'http://localhost:3000';
  const r = checkConfig(cfg, cloneEnv());
  const item = find(r, 'APP_URL');
  assert.equal(item.level, 'warning');
  assert.match(item.problem, /localhost/i);
});

test('a missing AI key is only a warning because the rest of the system still works', () => {
  const cfg = clone();
  cfg.ai.apiKey = '';
  const env = cloneEnv();
  delete env.AI_API_KEY;
  const r = checkConfig(cfg, env);
  const item = find(r, 'AI_API_KEY');
  assert.equal(item.level, 'warning');
  assert.equal(r.ok, true, 'AI is not required to deliver an exam');
});

test('no message anywhere in the report contains a secret value', () => {
  const secrets = ['SUPER-SECRET-APP-SECRET', 'EAAG-real', 'verify-me', 'a-strong-password', 'sk-live'];
  // Deliberately broken config, so every branch that could leak runs.
  const env = { ADMIN_PASSWORD: 'changeme', CORS_ORIGIN: 'example.com' };
  const cfg = clone();
  cfg.whatsapp = { accessToken: 'EAAG-real', phoneNumberId: '', verifyToken: 'verify-me', appSecret: 'SUPER-SECRET-APP-SECRET', templateName: '' };
  const r = checkConfig(cfg, env);
  const blob = JSON.stringify(r);
  for (const s of secrets) {
    assert.ok(!blob.includes(s), `report leaked a secret: ${s}`);
  }
  assert.ok(!blob.includes('exam_invite'), 'report leaked a template name');
});

test('counts match the items actually produced', () => {
  const env = cloneEnv();
  delete env.WHATSAPP_APP_SECRET;
  delete env.WHATSAPP_TEMPLATE_NAME;
  const cfg = clone();
  cfg.whatsapp.templateName = '';
  const r = checkConfig(cfg, env);
  const tally = { critical: 0, warning: 0, info: 0 };
  for (const i of r.items) tally[i.level]++;
  assert.deepEqual(r.counts, tally);
  assert.equal(r.ok, r.counts.critical === 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/config-check.test.js`
Expected: FAIL with `Cannot find module '../src/services/configCheck'`.

- [ ] **Step 3: Implement `statusOf` and the check list**

Create `src/services/configCheck.js`:

```js
'use strict';

/**
 * Startup/operations self-check.
 *
 * Reports which settings are missing and what each one breaks. It NEVER
 * returns a secret value — only 'set', 'placeholder' or 'missing' — so it is
 * safe to print to logs, serve to the dashboard, or paste into a ticket.
 *
 * Reads the RAW env, not the sanitised config: src/config.js deliberately
 * blanks any value that looks like a placeholder, so a copied .env.example
 * would otherwise report as configured.
 */

const PLACEHOLDER_RE = /your_|example|changeme|replace_|^$/i;

function statusOf(value) {
  if (value === undefined || value === null) return 'missing';
  const v = String(value).trim();
  if (!v) return 'missing';
  if (PLACEHOLDER_RE.test(v)) return 'placeholder';
  return 'set';
}

/**
 * key, level, and how to derive `status`. `status` is computed from env when
 * the key is given (so placeholders are visible), otherwise from the config
 * value itself.
 */
const CHECKS = [
  {
    key: 'ADMIN_PASSWORD',
    level: 'critical',
    envKey: 'ADMIN_PASSWORD',
    problem: 'With no ADMIN_PASSWORD a random one is generated on every boot, so you are locked out of the dashboard after any redeploy or restart.',
    fix: 'Set ADMIN_PASSWORD in .env (and in your host\'s environment variables) to a strong, stable value.',
    criticalWhen: (status, config) => status !== 'set' || config.admin.isGenerated,
  },
  {
    key: 'WHATSAPP_APP_SECRET',
    level: 'critical',
    envKey: 'WHATSAPP_APP_SECRET',
    problem: 'Every webhook POST is verified with x-hub-signature-256 against this secret. Without it the webhook returns 403 before reading the body, so no student answer or delivery status is ever recorded — every session then looks like the student never started.',
    fix: 'Copy the App secret from developers.facebook.com -> your app -> Settings -> Basic into WHATSAPP_APP_SECRET.',
    criticalWhen: (status) => status !== 'set',
  },
  {
    key: 'WHATSAPP_ACCESS_TOKEN',
    level: 'critical',
    envKey: 'WHATSAPP_ACCESS_TOKEN',
    problem: 'No access token means no message can be sent. Every send fails immediately.',
    fix: 'Create a permanent System User token in the Meta Business dashboard and set WHATSAPP_ACCESS_TOKEN.',
    criticalWhen: (status) => status !== 'set',
  },
  {
    key: 'WHATSAPP_PHONE_NUMBER_ID',
    level: 'critical',
    envKey: 'WHATSAPP_PHONE_NUMBER_ID',
    problem: 'Without the sending number ID, Meta has no number to send from and every send fails.',
    fix: 'Set WHATSAPP_PHONE_NUMBER_ID to the numeric ID shown in WhatsApp -> API Setup.',
    criticalWhen: (status) => status !== 'set',
  },
  {
    key: 'WHATSAPP_VERIFY_TOKEN',
    level: 'critical',
    envKey: 'WHATSAPP_VERIFY_TOKEN',
    problem: 'Meta uses this string to confirm it is talking to your webhook during setup. The webhook cannot be registered without it.',
    fix: 'Set WHATSAPP_VERIFY_TOKEN to any long random string you choose, and enter the same value in the Meta webhook form.',
    criticalWhen: (status) => status !== 'set',
  },
  {
    key: 'WHATSAPP_TEMPLATE_NAME',
    level: 'critical',
    envKey: 'WHATSAPP_TEMPLATE_NAME',
    problem: 'Without an approved template the first message is sent free-form, which Meta rejects with error 131026 for any number that has never messaged your business — so cold recipients never receive the exam.',
    fix: 'Submit and get a WhatsApp template approved, then set WHATSAPP_TEMPLATE_NAME (plus WHATSAPP_TEMPLATE_LANGUAGE and any {{1}} values in WHATSAPP_TEMPLATE_PARAMS).',
    criticalWhen: (status, config) => status !== 'set' && !config.whatsapp.templateName,
  },
  {
    key: 'APP_URL',
    level: 'warning',
    fromConfig: (config) => config.appUrl,
    problem: 'APP_URL builds the webhook URL and the links inside result messages. On a public host a localhost value produces links that no student can open.',
    fix: 'Set APP_URL to the public HTTPS origin of this server, with no trailing slash.',
    criticalWhen: (status) => status === 'missing',
  },
  {
    key: 'AI_API_KEY',
    level: 'warning',
    envKey: 'AI_API_KEY',
    problem: 'Without an AI key you cannot generate questions, extract a PDF, or build a marking scheme. Exams can still be written by hand and delivered.',
    fix: 'Set AI_API_KEY and AI_BASE_URL for any OpenAI-compatible provider.',
    criticalWhen: () => false,
  },
  {
    key: 'CORS_ORIGIN',
    level: 'info',
    envKey: 'CORS_ORIGIN',
    problem: 'Only localhost and 127.0.0.1 are allowed by default. A dashboard served from any other origin will have its API calls blocked.',
    fix: 'Set CORS_ORIGIN to a comma-separated list of allowed origins.',
    criticalWhen: () => false,
  },
];

function checkConfig(config, env = process.env) {
  const items = [];
  for (const c of CHECKS) {
    const raw = c.envKey ? env[c.envKey] : c.fromConfig(config);
    const status = statusOf(raw);
    items.push({
      level: c.criticalWhen(status, config) ? 'critical' : c.level,
      key: c.key,
      status,
      problem: c.problem,
      fix: c.fix,
    });
  }
  // A configured key is worth stating too, so the checklist reads as a
  // complete picture rather than only a list of complaints.
  for (const c of CHECKS) {
    if (c.level === 'info') continue;
    const raw = c.envKey ? env[c.envKey] : c.fromConfig(config);
    if (statusOf(raw) === 'set') {
      items.push({ level: 'info', key: c.key, status: 'set', problem: 'Configured.', fix: '' });
    }
  }
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const i of items) counts[i.level]++;
  return { ok: counts.critical === 0, counts, items };
}

module.exports = { checkConfig, statusOf };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/config-check.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/configCheck.js test/config-check.test.js
git commit -m "feat(config): add a self-check that reports missing settings

A missing WHATSAPP_APP_SECRET, an unapproved template, and a generated
admin password each break a different part of an exam and none of them
fail loudly. Reports status words only, so no secret reaches the log."
```

---

## Task 2: Boot banner

Replace the ad-hoc warnings in `src/server.js:287-294` with the shared report, so the boot output and the CLI can never disagree.

**Files:**
- Modify: `src/server.js:3` (add the require) and `src/server.js:287-294`

**Interfaces:**
- Consumes: `checkConfig(config, process.env) -> report` from Task 1.
- Produces: boot log lines. No new exports.

- [ ] **Step 1: Add the require**

Next to the other requires at `src/server.js:3-7`, add:

```js
const { checkConfig } = require('./services/configCheck');
```

- [ ] **Step 2: Replace the warning block**

Replace `src/server.js:287-294` — the `if (config.admin.isGenerated)` and
`if (!config.whatsapp.appSecret)` blocks — with:

```js
      const check = checkConfig(config, process.env);
      for (const item of check.items) {
        if (item.status === 'set' && item.level === 'info') continue;
        const tag = item.level === 'critical' ? '✗ CRITICAL' : item.level === 'warning' ? '⚠ WARNING' : 'ℹ';
        console.warn(`${tag}  ${item.key} (${item.status}) — ${item.problem}`);
        if (item.fix) console.warn(`          fix: ${item.fix}`);
      }
      if (!check.ok) {
        console.warn(`${check.counts.critical} critical setting(s) will break exam delivery. Run: npm run config:check`);
      }
```

This deliberately drops the old `admin.isGenerated` and `appSecret` special
cases: both are now `critical` items in the report, so keeping them would
duplicate the message.

- [ ] **Step 3: Verify by booting with a deliberately broken env**

Run: `$env:WHATSAPP_APP_SECRET=""; $env:ADMIN_PASSWORD=""; npm start`
Expected: a `✗ CRITICAL  WHATSAPP_APP_SECRET (missing)` line, a
`✗ CRITICAL  ADMIN_PASSWORD (missing)` line, and a final line naming
`npm run config:check`.

Run: `Remove-Item Env:WHATSAPP_APP_SECRET, Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue` to restore the shell.

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat(config): print the full self-check at boot

Replaces the two hardcoded warnings with the shared report so boot output
and the CLI cannot drift, and covers the template and token gaps."
```

---

## Task 3: CLI

`Files:`
- Create: `scripts/config-check.js`
- Modify: `package.json:9-14`

**Interfaces:**
- Consumes: `checkConfig(config, process.env)`.
- Produces: `npm run config:check` — human-readable output, exit 1 when any critical item exists.

- [ ] **Step 1: Create the CLI**

```js
#!/usr/bin/env node
'use strict';
// Prints a redacted configuration checklist. Exit code 1 when a critical
// setting is missing, so it can gate a deploy step in CI.
require('dotenv').config();
const { checkConfig } = require('../src/services/configCheck');
const config = require('../src/config');

const SYMBOL = { critical: '✗', warning: '⚠', info: '·' };
const report = checkConfig(config, process.env);

console.log('\nWhat Exam — configuration self-check');
console.log('='.repeat(56));
for (const item of report.items) {
  if (item.status === 'set' && item.level === 'info') {
    console.log(`  ${SYMBOL.info} ${item.key.padEnd(26)} set`);
    continue;
  }
  console.log(`  ${SYMBOL[item.level]} ${item.key.padEnd(26)} ${item.status}`);
  console.log(`      ${item.problem}`);
  if (item.fix) console.log(`      → ${item.fix}`);
  console.log('');
}
console.log('-'.repeat(56));
console.log(`  ${report.counts.critical} critical, ${report.counts.warning} warning, ${report.counts.info} info`);
console.log('='.repeat(56));

if (report.ok) {
  console.log('\n✓ Ready to send exams.\n');
} else {
  console.log('\n✗ Fix the critical items above before sending an exam.\n');
  console.log('  Copy .env.example to .env as a starting point, then fill in the\n');
  console.log('  three critical values: ADMIN_PASSWORD, WHATSAPP_APP_SECRET,\n');
  console.log('  WHATSAPP_TEMPLATE_NAME.\n');
  process.exit(1);
}
```

- [ ] **Step 2: Add the npm script**

Read `package.json` to find the `scripts` block, then add:

```json
"config:check": "node scripts/config-check.js"
```

- [ ] **Step 3: Verify both outcomes**

Run: `npm run config:check`
Expected (this project's real `.env`, which lacks all three critical keys):
`✗ ADMIN_PASSWORD missing`, `✗ WHATSAPP_APP_SECRET missing`,
`✗ WHATSAPP_TEMPLATE_NAME missing`, and exit code 1.

Run: `$env:ADMIN_PASSWORD="pw"; $env:WHATSAPP_APP_SECRET="s"; $env:WHATSAPP_TEMPLATE_NAME="t"; npm run config:check`
Expected: those three flip to `set`, and it prints `✓ Ready to send exams.`
with exit code 0.

Run: `Remove-Item Env:ADMIN_PASSWORD, Env:WHATSAPP_APP_SECRET, Env:WHATSAPP_TEMPLATE_NAME -ErrorAction SilentlyContinue`

- [ ] **Step 4: Commit**

```bash
git add scripts/config-check.js package.json
git commit -m "feat(config): add npm run config:check

Prints a redacted readiness checklist and exits non-zero on a critical
gap, so a deploy can gate on it."
```

---

## Task 4: `GET /api/config-check`

**Files:**
- Modify: `src/routes/api.js` (add the route next to `GET /api/stats`)

**Interfaces:**
- Consumes: `checkConfig(config, process.env)`.
- Produces: `GET /api/config-check` → the Task 1 report JSON, behind the existing auth middleware.

- [ ] **Step 1: Find the router setup and the stats route**

Run: `Select-String -Path src/routes/api.js -Pattern "api.get\('/stats'" -Context 6,3`
Expected: a `/stats` handler. Read the surrounding lines to confirm the auth
middleware is applied to the whole `router` (look for `router.use(auth...)` or
per-route middleware) and copy that style exactly — do not introduce a route
that bypasses auth, since the report reveals which settings are missing.

- [ ] **Step 2: Add the route**

```js
router.get('/config-check', (req, res) => {
  res.json(require('../services/configCheck').checkConfig(require('../config'), process.env));
});
```

If the router does not have `../services/configCheck` resolvable, hoist the
require to the top of `src/routes/api.js` instead of requiring inline.

- [ ] **Step 3: Verify the route**

Start the server, log in through `POST /api/auth/login` with the current
`ADMIN_PASSWORD`, then:

```bash
curl -s http://localhost:3000/api/config-check -H "Authorization: Bearer <token>"
```

Expected: JSON with `ok: false` and the three critical keys. Confirm the
response body contains no secret value — it must not echo the access token or
admin password.

Also confirm it is protected: repeat the call with no token and expect `401`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api.js
git commit -m "feat(api): expose GET /api/config-check behind auth

Lets the dashboard show the same checklist the CLI prints."
```

---

## Task 5: Document the settings that `.env.example` still omits

`.env.example` documents the WhatsApp keys well, but several knobs the code
reads are undocumented, so operators cannot tune them without reading source.

**Files:**
- Modify: `.env.example:84-96` (extend the exam-defaults block)

- [ ] **Step 1: Extend the exam-defaults block**

Append to the `# ── Exam defaults ──` section:

```ini
# How many students are messaged at once (WhatsApp rate-limits aggressively)
SEND_CONCURRENCY=2
# Attempts per message inside a single send, on top of the cross-message
# retries. Raise only if you are seeing transient 5xx from Meta.
SEND_RETRIES=3
# Base delay between those retries, in ms. Doubles each attempt.
SEND_RETRY_DELAY_MS=5000
# Send the PDF result document after an exam finishes?
SEND_CERTIFICATES=true
# How often expired sessions are closed in the background (ms). A session past
# its deadline is finalised exactly like a normal timer expiry.
STALE_SESSION_CLEANUP_MS=60000
```

- [ ] **Step 2: Note the eleven provider keys**

`.env` sets `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`, but `src/config.js`
has no `elevenLabs` block — those values are currently unread by the server.
Do not add a config block (the advert work is deferred); instead add a
comment at the end of the existing ElevenLabs block in `.env.example`:

```ini
# NOTE: not yet read by src/config.js — the advert voiceover pipeline is deferred.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document tuning keys missing from .env.example

SEND_CONCURRENCY, SEND_RETRIES, SEND_RETRY_DELAY_MS, SEND_CERTIFICATES and
STALE_SESSION_CLEANUP_MS are read by config.js but undocumented, and the
ElevenLabs keys are set but not read."
```

---

## Task 6: Register the test file and verify

`npm test` enumerates files explicitly, so an unregistered suite never runs.

**Files:**
- Modify: `package.json:13` (`test` script)

- [ ] **Step 1: Add the suite**

```json
"test": "node --test test/regression.test.js test/pdf-images.test.js test/image-answers.test.js test/recipient-dedupe.test.js test/config-check.test.js",
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(test): register config-check suite in npm test"
```

---

## Verification

```bash
npm test
npm run config:check
git status --short
```

Expected: green suite; the CLI exits 1 listing exactly the three critical gaps
in this project's real environment; a clean tree.

Then walk the operator path end to end:

1. `npm run config:check` with a broken env → three `✗` lines and exit 1.
2. Fill `ADMIN_PASSWORD`, `WHATSAPP_APP_SECRET`, `WHATSAPP_TEMPLATE_NAME` in
   `.env` → `✓ Ready to send exams.`, exit 0.
3. Restart and confirm the boot banner no longer lists them.
4. Send a test WhatsApp message to a number that has **never** messaged the
   business. With the template set it must arrive; unset, it fails 131026.
5. Have that number reply, and confirm the reply is stored — the 403 rejection
   is gone.

## Rollback

Fully reversible. `checkConfig` is read-only; deleting `src/services/configCheck.js`,
`scripts/config-check.js`, the `config:check` script and the route restores the
previous behaviour. No schema or data change is involved.

## Out of Scope

- Writing real values into `.env`. The operator does that using the checklist.
- Verifying a token against Meta's API at boot. That would leak the token into a
  third-party call on every restart; the presence check is enough.
- Validating `ELEVENLABS_*`, `XAI_*`, `CLAUDE_*` or `PUTER_API_KEY` at the
  `critical` level — all are optional providers, reported at most as `info`.
- Refactoring `config.js` to stop discarding placeholder-looking secrets.
- The dashboard UI for the checklist. The endpoint is enough for now; wire it
  into `src/public/app.js` when the dashboard has a settings page.
