const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { checkConfig } = require('./services/configCheck');

// On a plan WITHOUT a disk (Render free tier) the container filesystem is
// erased on every deploy — there is nothing to mount, so persistence lives in
// a private GitHub repo instead. The restore MUST finish before ./routes/api
// below is required: that require opens (and on a fresh container CREATES) the
// database file, and a restore racing it would lose. Synchronous on purpose —
// CommonJS has no top-level await — the download happens in a child process
// (services/backupWorker.js) that this call blocks on. No-op unless
// BACKUP_GITHUB_TOKEN and BACKUP_GITHUB_REPO are set.
if (require.main === module) {
  require('./services/backup').restoreSync();
}

const api = require('./routes/api');
const webhook = require('./routes/webhook');
const results = require('./services/results');
const auth = require('./auth');

const app = express();
// Don't advertise the stack in every response header.
app.disable('x-powered-by');

function originAllowed(origin) {
  if (config.corsOrigins.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
// Origins that were refused, logged once each: a cross-origin dashboard that
// is not allow-listed fails in the browser as an opaque "Failed to fetch"
// with nothing actionable in either the page or the response — naming the
// origin here turns the mystery into one log line with the fix.
const warnedOrigins = new Set();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // Without this, cross-origin JavaScript cannot read Content-Disposition,
    // even though the browser is willing to send it. The dashboard runs on a
    // different origin from the API, so a roster file download would always
    // fall back to a generic name instead of the exam-specific one the server
    // chose (including its UTF-8 form for non-ASCII exam titles).
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Vary', 'Origin');
  } else if (origin && !warnedOrigins.has(origin)) {
    warnedOrigins.add(origin);
    console.warn(`[cors] blocked origin ${origin} — a dashboard served from that address cannot call the API (the browser will only show "Failed to fetch"). Set CORS_ORIGIN (comma-separated) to allow it.`);
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Webhook must be mounted BEFORE express.json() so the raw body is intact
// for x-hub-signature-256 HMAC verification.
app.use('/webhook/whatsapp', webhook);
// Paystack signs the raw bytes too (x-paystack-signature, HMAC-SHA512), so it
// goes in front of json parsing for exactly the same reason.
app.use('/webhook/paystack', require('./routes/paystackWebhook'));

app.use(express.json({ limit: '2mb' }));
app.use('/api', api);
app.get('/report/:sessionId/attachment', (req, res) => {
  if (!auth.verifyReportToken(req.query.token, req.params.sessionId)) {
    return res.status(403).send('Invalid or expired report link.');
  }
  const name = path.basename(String(req.query.file || ''));
  if (!/^[\w-]+\.png$/i.test(name)) return res.status(400).send('Bad file name');
  const full = path.join(config.uploadsDir, name);
  // Checked up front: res.sendFile() returns undefined in Express 4, so the
  // old `.sendFile(...).on('error')` chain threw a TypeError and turned every
  // missing attachment into a 500 instead of a 404.
  if (!fs.existsSync(full)) return res.status(404).end();
  res.type('image/png').sendFile(full);
});

// A question's figure, for WhatsApp to fetch itself.
//
// This is the fallback transport for `image.link`: /api demands a bearer token
// Meta cannot present, so a figure needs a route that is public but signed —
// one file, one token, an expiry. Without it, a media upload Meta refuses
// (oversized crop, media permission missing) leaves the student reading a
// question whose diagram only ever existed on this server.
app.get('/figure/:file', (req, res) => {
  const name = path.basename(String(req.params.file || ''));
  if (!/^[\w-]+\.(png|jpe?g|webp|gif)$/i.test(name)) return res.status(400).send('Bad file name');
  if (!auth.verifyFigureToken(req.query.token || '', name)) {
    return res.status(403).send('Invalid or expired figure link.');
  }
  const full = path.join(config.uploadsDir, name);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.type(path.extname(name).slice(1)).sendFile(full);
});

app.get('/report/:sessionId', (req, res) => {
  if (!auth.verifyReportToken(req.query.token, req.params.sessionId)) {
    return res
      .status(403)
      .send('This report link is invalid or expired. Ask your administrator to resend your result.');
  }
  const r = results.reportHTML(req.params.sessionId);
  res.status(r.status).send(r.html);
});

const API_GROUPS = [
  ['System', [
    ['GET', '/health', 'Health check'],
    ['GET', '/api/stats', 'Dashboard summary counts'],
  ]],
  ['Auth', [
    ['POST', '/api/auth/login', 'Sign in — returns a bearer token (required for all /api routes)'],
  ]],
  ['Exams', [
    ['GET', '/api/exams', 'List exams'],
    ['POST', '/api/exams', 'Create an exam (pricing: free|paid, amount in GHS)'],
    ['GET', '/api/exams/:id', 'Exam detail (questions, recipients, results, payments)'],
    ['PATCH', '/api/exams/:id', 'Update exam meta'],
    ['DELETE', '/api/exams/:id', 'Delete an exam'],
    ['POST', '/api/exams/:id/publish', 'Publish (make live)'],
    ['POST', '/api/exams/:id/end', 'End a live exam'],
    ['POST', '/api/exams/:id/archive', 'Archive an exam'],
  ]],
  ['Payments', [
    ['GET', '/api/exams/:id/payments', 'Payment attempts for a paid exam'],
    ['POST', '/webhook/paystack', 'Paystack charge notifications (signed, raw body)'],
  ]],
  ['Recipients & Delivery', [
    ['POST', '/api/exams/:id/recipients', 'Add recipient phones'],
    ['DELETE', '/api/exams/:id/recipients/:studentId', 'Remove a recipient'],
    ['POST', '/api/exams/:id/send', 'Send exam to recipients via WhatsApp'],
  ]],
  ['Questions & Schemes', [
    ['POST', '/api/exams/:id/questions', 'Add a question'],
    ['PUT', '/api/exams/:id/questions/:qid', 'Update a question'],
    ['DELETE', '/api/exams/:id/questions/:qid', 'Delete a question'],
    ['PUT', '/api/exams/:id/scheme/:qid', 'Edit a marking scheme (JSON)'],
    ['POST', '/api/exams/:id/scheme/:qid/generate', 'Regenerate scheme with AI'],
  ]],
  ['AI & Files', [
    ['POST', '/api/exams/:id/generate', 'AI-generate questions'],
    ['POST', '/api/exams/:id/pdf', 'Extract questions from uploaded PDF'],
  ]],
  ['Results & Students', [
    ['GET', '/api/results', 'Completed sessions'],
    ['GET', '/api/results/:sessionId', 'Session detail + answers'],
    ['PATCH', '/api/results/:sessionId/answers/:answerId', 'Adjust awarded marks'],
    ['GET', '/api/results/:sessionId/report-url', 'Get a signed shareable report link'],
    ['POST', '/api/results/:sessionId/resend', 'Resend result via WhatsApp'],
    ['GET', '/api/students', 'List students'],
    ['PATCH', '/api/students/:id', 'Rename a student'],
  ]],
  ['Reports & WhatsApp', [
    ['GET', '/report/:sessionId', 'Printable HTML report for a session'],
    ['GET', '/webhook/whatsapp', 'WhatsApp webhook verification (GET)'],
    ['POST', '/webhook/whatsapp', 'WhatsApp webhook events'],
  ]],
];

function methodClass(m) {
  return m === 'GET' ? 'get' : m === 'POST' ? 'post' : m === 'PUT' || m === 'PATCH' ? 'put' : 'del';
}

function endpointLink(m, p) {
  if (m === 'GET' && !p.includes(':')) {
    return `<a href="${p}" target="_blank" rel="noopener"><code>${p}</code></a>`;
  }
  return `<code>${p}</code>`;
}

// ── The dashboard ───────────────────────────────────────────────────────
// Served by THIS server so the SPA and the API share one origin by
// construction: no CORS configuration to misconfigure, no local frontend
// process to keep alive, and the same root URL works from the admin's
// phone, a second office machine or Termux — the exact setups that used to
// fail as an unexplainable "Failed to fetch" because a non-localhost origin
// is refused by default. frontend.js keeps serving these identical files
// for local development (its /config.js answers with config.appUrl).
//
// /config.js is registered BEFORE the static middleware, exactly like
// frontend.js does, so the committed fallback file never wins.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  // The server that served the page IS the API — wherever the page was
  // opened from (onrender.com, a LAN address, localhost).
  res.send('window.API_BASE = window.location.origin;');
});
app.use(express.static(path.join(__dirname, 'public'), {
  // The dashboard ships new JS with every deploy; heuristically cached
  // copies are how an admin ends up staring at last week's bug. Revalidate
  // (304s are cheap — these files are kilobytes).
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// The API reference index — formerly at '/', which now belongs to the
// dashboard: the root URL is what an admin types.
app.get('/api-docs', (req, res) => {
  const wa = config.whatsapp.accessToken ? 'on' : 'off';
  const ai = config.ai.apiKey ? 'on' : 'off';
  const rows = API_GROUPS.map(
    ([group, eps]) => `
      <h2 class="group">${group}</h2>
      <table><tbody>
        ${eps
          .map(
            ([m, p, d]) => `<tr>
              <td class="m"><span class="method ${methodClass(m)}">${m}</span></td>
              <td>${endpointLink(m, p)}</td>
              <td class="m">${d}</td>
            </tr>`
          )
          .join('')}
      </tbody></table>`
  ).join('');
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>La_Exam API</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--line:#334155;--fg:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8}
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;min-height:100vh}
  .wrap{max-width:900px;margin:0 auto;padding:32px 20px 64px}
  header{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;margin-bottom:8px}
  h1{font-size:24px;margin:0}
  .sub{color:var(--muted);margin:6px 0 0}
  .badges{display:flex;gap:8px;flex-wrap:wrap}
  .badge{padding:5px 12px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--line)}
  .badge.on{background:#14532d;color:#86efac;border-color:#166534}
  .badge.off{background:#7f1d1d;color:#fca5a5;border-color:#991b1b}
  .group{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin:28px 0 8px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  td{padding:10px 14px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .m{color:var(--muted);white-space:nowrap}
  code{background:#0b1220;padding:2px 7px;border-radius:6px;font-size:12px;color:#e2e8f0}
  a{color:var(--accent);text-decoration:none}
  a code{color:var(--accent)}
  .method{display:inline-block;min-width:52px;text-align:center;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700}
  .method.get{background:#0f3d2e;color:#4ade80}
  .method.post{background:#1e3a8a;color:#93c5fd}
  .method.put{background:#78350f;color:#fbbf24}
  .method.del{background:#7f1d1d;color:#f87171}
  footer{margin-top:32px;color:var(--muted);font-size:12px;display:flex;gap:16px;flex-wrap:wrap}
  @media(max-width:640px){td{white-space:normal} .m{white-space:nowrap}}
</style></head><body><div class="wrap">
<header>
  <div>
    <h1>What Exam API</h1>
    <p class="sub">Backend server &mdash; JSON API, WhatsApp webhook, and reports</p>
  </div>
  <div class="badges">
    <span class="badge ${wa}">WhatsApp ${wa === 'on' ? 'configured' : 'not configured'}</span>
    <span class="badge ${ai}">AI ${ai === 'on' ? `configured (${config.ai.model})` : 'not configured'}</span>
  </div>
</header>
<p class="sub">Admin dashboard: <a href="${config.frontendUrl}">${config.frontendUrl}</a> &middot; Webhook: <code>${config.appUrl}/webhook/whatsapp</code></p>
${rows}
<footer>
  <span>What Exam v1.0.0</span>
  <a href="${config.frontendUrl}">Dashboard</a>
  <a href="/health">Health</a>
</footer>
</div></body></html>`);
});

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => res.json({ allowed_origins: [] }));

app.get('/privacy', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Privacy Policy — La_Exam</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--line:#334155;--fg:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8}
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;line-height:1.65}
  .wrap{max-width:760px;margin:0 auto;padding:40px 20px 64px}
  h1{font-size:24px;margin:0 0 4px}
  .sub{color:var(--muted);margin:0 0 28px}
  h2{font-size:16px;color:var(--accent);margin:24px 0 8px}
  p{color:var(--fg);margin:6px 0}
  a{color:var(--accent)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-top:8px}
  footer{margin-top:40px;color:var(--muted);font-size:12px}
</style></head><body><div class="wrap">
<h1>Privacy Policy</h1>
<p class="sub">What Exam — last updated August 2026</p>

<div class="card">
<h2>1. Data we collect</h2>
<p>What Exam collects the information needed to run WhatsApp-based examinations: student name, WhatsApp phone number, exam responses, and exam results. We do not collect more personal data than is necessary for the service.</p>

<h2>2. How we use your data</h2>
<p>Your phone number is used solely to deliver exams and results to you over WhatsApp. Your responses are used to mark exams and produce results. No data is sold or shared with third parties for marketing.</p>

<h2>3. Data storage</h2>
<p>Data is stored on secure servers operated by the service provider (Render). We take reasonable measures to protect your information, but no method of transmission or storage is 100% secure.</p>

<h2>4. WhatsApp</h2>
<p>This service uses the WhatsApp Business Platform. By using the service you agree to WhatsApp's Terms of Service and acknowledge that message delivery is handled by WhatsApp/Meta.</p>

<h2>5. Data retention &amp; deletion</h2>
<p>Data is kept for as long as needed to administer exams. To request deletion of your data, contact the administrator of the school or institution that issued your exam.</p>

<h2>6. Contact</h2>
<p>For privacy questions, contact the institution administrator that provided this exam.</p>
</div>

<footer><a href="/">← Back to API</a> · What Exam</footer>
</div></body></html>`);
});

app.get('/health', (req, res) => res.json({ ok: true, appUrl: config.appUrl }));

app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: `Upload failed: ${err.message}` });
  }
  console.error(err);
  // Don't leak internal details (file paths, stack traces) in production
  const safeMsg = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : (err.message || 'Internal server error');
  res.status(err.status || 500).json({ error: safeMsg });
});

if (require.main === module) {
  const run = async () => {
    const db = require('./db');
    const { seedIfEmpty } = require('../scripts/seed-exam');
    // Fail any import left mid-flight by a previous process (crash/redeploy)
    // so stale jobs can never hang the dashboard poll or block new uploads.
    require('./services/pdfImport').recoverStaleJobs();
    // Release sessions a crashed process left claimed by finalize(), then
    // finalize sessions left in_progress past their deadline by a crash or
    // redeploy — each is closed and reported exactly like timer expiry.
    require('./services/exam').recoverInterruptedFinalizes();
    await require('./services/exam').finalizeStaleSessions();
    // Start periodic background cleanup so expired sessions are finalized
    // automatically instead of only on server restart.
    require('./services/exam').startStaleSessionCleanup();

    // Settle payments the Paystack webhook never reached, and open the
    // paper for anyone who paid but still has no attempt. Without this
    // a lost webhook meant a paid student sat waiting forever — the
    // sweep makes the unlock independent of the webhook arriving.
    require('./services/payments').startPaymentSweep();

    // Diskless plan (Render free): everything below rides on the GitHub
    // backup. If the restore at the top of this file succeeded, the data
    // this boot just loaded IS the previous deployment's — push it back out
    // immediately, then on the interval, and once more on SIGTERM when
    // Render replaces the container.
    const backup = require('./services/backup');
    backup.startBackupLoop();
    backup.flushOnShutdown();

    // Loud, unmissable warning when storage is still on the container
    // filesystem. Render discards that on every deploy and restart, which
    // silently wipes the database - students, sessions and graded answers - and
    // every uploaded photo and voice note. It then re-seeds a fresh exam, which
    // made the loss look like a normal boot. Losing a live exam database is far
    // too expensive to discover from a log line further down.
    //
    // Both failure shapes are covered:
    //   1. the variables are unset (legacy check), and
    //   2. they are SET but point inside the container filesystem anyway -
    //      no disk mounted, or a disk mounted at a different path. Shape 2 is
    //      the one that bit a live deployment: the old warning stayed silent,
    //      the logs showed nothing worse than a routine "[seed] DB was empty",
    //      and every deploy quietly destroyed the previous database.
    // The check runs only on Render (RENDER env var): elsewhere the mount
    // table of a developer's machine would report ./data as "ephemeral" and
    // cry wolf on every local boot.
    //
    // Exception: on a plan WITHOUT disks (Render free tier) a disk cannot be
    // mounted at all — the GitHub backup configured above IS the persistence.
    // Then the risk is real only if the restore at boot failed or never
    // succeeded, and the banner below says exactly that instead.
    const onRender = !!process.env.RENDER;
    const unsetStorage = !process.env.DB_PATH && !process.env.UPLOADS_DIR;
    const onEphemeralStorage = unsetStorage
      || (onRender && require('./services/storageHealth')
        .ephemeralPaths([config.dbPath, config.uploadsDir]).length > 0);
    const restoreStatus = (backup.getStatus().lastRestore || {}).status;
    if (onEphemeralStorage && !backup.isConfigured()) {
      console.warn('');
      console.warn('  ============================================================================');
      console.warn(unsetStorage
        ? '   DATA LOSS RISK: DB_PATH and UPLOADS_DIR are not set.'
        : '   DATA LOSS RISK: DB_PATH/UPLOADS_DIR are set, but not on a mounted disk.');
      console.warn('');
      console.warn('   The database and uploads are inside the container filesystem, which');
      console.warn('   Render DELETES on every deploy and restart. Every student, session,');
      console.warn('   graded answer, photo and voice note will be gone.');
      if (!unsetStorage) {
        console.warn('');
        console.warn('   Set does not mean safe: these paths resolve to the container FS:');
        console.warn(`        DB_PATH      -> ${config.dbPath}`);
        console.warn(`        UPLOADS_DIR  -> ${config.uploadsDir}`);
        console.warn('   A disk must be mounted at /opt/render/project/src/data (Render');
        console.warn('   dashboard -> service -> Disks) for these paths to survive a deploy.');
      }
      console.warn('');
      console.warn('   Paid plan:  mount a Render disk at /opt/render/project/src/data, then set');
      console.warn('        DB_PATH=/opt/render/project/src/data/exams.db');
      console.warn('        UPLOADS_DIR=/opt/render/project/src/data/uploads');
      console.warn('        (render.yaml in the repo has this ready to apply.)');
      console.warn('   Free plan:  disks do not exist there — set instead');
      console.warn('        BACKUP_GITHUB_TOKEN=<private-repo token>');
      console.warn('        BACKUP_GITHUB_REPO=<you/private-backup-repo>');
      console.warn('        and the app restores from GitHub at boot and pushes backups');
      console.warn('        on an interval. The repo MUST be private: it holds student data.');
      console.warn('  ============================================================================');
      console.warn('');
    } else if (onEphemeralStorage && restoreStatus === 'error') {
      // Backup is configured but this boot could NOT restore: it is running
      // empty exactly like the un-backuped case. Doom applies again.
      console.warn('');
      console.warn('  ============================================================================');
      console.warn('   DATA LOSS RISK: storage is ephemeral AND the GitHub restore FAILED.');
      console.warn(`        ${(backup.getStatus().lastRestore || {}).error || 'unknown error'}`);
      console.warn('   This boot started from an empty database. The remote copy is intact —');
      console.warn('   check the [backup] lines above (token, repo name, repo is private).');
      console.warn('  ============================================================================');
      console.warn('');
    } else if (onEphemeralStorage) {
      // Ephemeral, but the GitHub backup is configured and this boot either
      // restored successfully or provably had nothing to restore.
      console.warn('');
      console.warn('  ============================================================================');
      console.warn('   Storage is the container filesystem (no disk on this plan): every');
      console.warn('   deploy would normally DELETE all students, sessions and uploads.');
      console.warn(`   GitHub backup is ON: restore at boot -> ${restoreStatus}; pushes every`);
      console.warn(`   ${Math.round(config.backup.intervalMs / 60000)} min to ${config.backup.repo}@${config.backup.branch}.`);
      console.warn('  ============================================================================');
      console.warn('');
    }

    if (config.seedOnBoot) {
      try {
        const s = seedIfEmpty(db);
        if (s.seeded) {
          console.log(`[seed] DB was empty — seeded exam "${s.title}" (id ${s.examId}, status ${s.status})`);
          // An empty database is NORMAL on a first boot against a fresh
          // persistent disk — and on the first boot of a GitHub-backuped
          // service, before the first backup exists. On an already-deployed
          // service it means the disk is not mounted (or the restore failed),
          // so a redeploy destroyed the previous data — say so plainly,
          // because the seed line above reads like routine startup.
          const restoredThisBoot = ['no-backup', 'restored', 'local-data'].includes(restoreStatus);
          if (onEphemeralStorage && !(backup.isConfigured() && restoredThisBoot)) {
            console.error(
              '[seed] WARNING: this re-seeded an empty database on an already-deployed service. ' +
              'If exams have run before, that data was lost with the container filesystem. ' +
              'Mount a persistent disk and set DB_PATH/UPLOADS_DIR, or configure the ' +
              'GitHub backup (BACKUP_GITHUB_TOKEN + BACKUP_GITHUB_REPO) on a free plan.'
            );
          }
        }
      } catch (e) {
        console.error('[seed] failed:', e.message);
      }
    }
    if (process.argv.includes('--init')) {
      console.log('Database initialised at', config.dbPath);
      return;
    }
    app.listen(config.port, '0.0.0.0', () => {
      console.log(`What Exam admin running at http://localhost:${config.port}`);
      console.log(`Webhook URL for WhatsApp: ${config.appUrl}/webhook/whatsapp`);
      const report = checkConfig(config, process.env);
      for (const item of report.items) {
        if (item.level === 'info' && item.status === 'set') continue;
        console.warn(`[${item.level.toUpperCase()}] ${item.key} (${item.status}): ${item.problem}`);
        if (item.fix) console.warn(`  Fix: ${item.fix}`);
      }
      if (!report.ok) console.warn(`${report.counts.critical} critical configuration gap(s). Run: npm run config:check`);
      console.log('Configuration check is local; credentials, template approval and reachability are not verified.');
    });
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = app;
