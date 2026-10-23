'use strict';

/**
 * Data persistence for hosts WITHOUT a disk (Render free tier and friends).
 *
 * On those plans the container filesystem — database AND uploads — is erased
 * on every deploy and restart, which made every redeploy silently destroy all
 * students, sessions and grades, and every figure file under a question. A
 * disk cannot be mounted there, so persistence has to live OUTSIDE the
 * container. This service uses GitHub as that outside: a PRIVATE repository
 * receives `exams.db` + `uploads.zip` on an interval, and at boot the last
 * backup is pulled back onto the fresh container BEFORE any module opens the
 * database (see server.js — routes open it at require time, so the restore is
 * synchronous, via a child process: CommonJS has no top-level await).
 *
 * Storage shape: each backup is a PARENTLESS commit force-moved onto the
 * backup branch — one commit holds exactly the current state, and every older
 * commit becomes unreachable for GitHub to prune. A decade of backups never
 * costs more storage than one.
 *
 * The repository MUST be private: it contains student answers, photos and
 * voice notes. The app's own repo is public — never point this at it.
 *
 * Off unless BACKUP_GITHUB_TOKEN and BACKUP_GITHUB_REPO are both set; with
 * neither, the app behaves exactly as before (ephemeral, with the loud boot
 * warning).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../config');
const { buildZip, readZip } = require('./zip');

const API = 'https://api.github.com';
// GitHub refuses a blob at or over 100 MB; leave margin and degrade loudly:
// a too-large uploads zip is dropped (the database still ships) — never
// silently shrink the one file the whole app depends on.
const MAX_BLOB_BYTES = 90 * 1024 * 1024;
const WORKER = path.join(__dirname, 'backupWorker.js');

// Last outcomes, for the boot banner and the shutdown log. `lastRestore` is
// set before routes load; `lastBackup` fills in once the loop has run.
let lastRestore = null;
let lastBackup = null;
let backupRunning = false;

/**
 * The configured repo, normalized at USE time. config.js already cleans a
 * pasted browser URL when it reads the env var, but tests — and any future
 * code that assigns config.backup directly — would bypass that; one
 * owner/name must hold no matter which path set it.
 */
function repoName() {
  const raw = (config.backup && config.backup.repo) || '';
  return raw.replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

function isConfigured() {
  return !!(config.backup && config.backup.token && repoName());
}

function getStatus() {
  return { lastRestore, lastBackup };
}

function authHeaders() {
  return {
    Authorization: `Bearer ${config.backup.token}`,
    Accept: 'application/vnd.github+json',
    // GitHub answers 403 without an explicit User-Agent.
    'User-Agent': 'la-exam-backup',
  };
}

/**
 * One GitHub API call. Returns { status, data }; 404 is a normal answer
 * (callers branch on it — "branch doesn't exist yet" is the first backup),
 * anything else non-2xx throws with GitHub's own message.
 */
async function gh(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok && res.status !== 404) {
    const msg = (data && data.message) || `HTTP ${res.status}`;
    const err = new Error(`GitHub ${init.method || 'GET'} ${pathname} → ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, data };
}

// ── restore ─────────────────────────────────────────────────────────────

/** Does THIS container's database already hold data worth keeping? */
function localDbHasData(dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  let handle = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    handle = new DatabaseSync(dbPath);
    const row = handle.prepare('SELECT COUNT(*) AS n FROM exams').get();
    return Number(row && row.n) > 0;
  } catch {
    // No exams table: an empty file this process can safely replace.
    return false;
  } finally {
    try { if (handle) handle.close(); } catch { /* already closed */ }
  }
}

/** Backup entry paths are attacker-shaped input in principle: stay inside. */
function safeUploadTarget(uploadsDir, name) {
  if (!name || name.includes('..') || name.includes('\0')) return null;
  if (name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return null;
  const dest = path.resolve(uploadsDir, name);
  const root = path.resolve(uploadsDir);
  if (dest !== root && !dest.startsWith(root + path.sep)) return null;
  return dest;
}

/**
 * Pull the backup branch onto this container. Runs in the boot child process
 * (backupWorker) in production and in-process under test with a stubbed
 * fetch — same function, no app module is ever loaded, so nothing here can
 * race the real database handle.
 *
 * Outcomes: not-configured | no-backup (first run) | restored | local-data
 * (this container already has data — never overwritten) | error.
 */
async function runRestore() {
  if (!isConfigured()) return { status: 'not-configured' };
  const repo = repoName();
  const { branch } = config.backup;

  // A container that already has data keeps it — checked before any network
  // call, so a restart of the same container never even asks GitHub.
  if (localDbHasData(config.dbPath)) return { status: 'local-data' };

  const ref = await gh(`/repos/${repo}/git/ref/heads/${branch}`);
  if (ref.status === 404 || !ref.data?.object?.sha) return { status: 'no-backup' };

  const commit = await gh(`/repos/${repo}/git/commits/${ref.data.object.sha}`);
  if (commit.status !== 200 || !commit.data.tree?.sha) return { status: 'no-backup' };

  const tree = await gh(`/repos/${repo}/git/trees/${commit.data.tree.sha}?recursive=1`);
  if (tree.status !== 200 || !Array.isArray(tree.data.tree)) throw new Error('backup tree is unreadable');
  const entry = (p) => tree.data.tree.find((t) => t.path === p && t.type === 'blob');

  const dbEntry = entry('exams.db');
  if (!dbEntry) return { status: 'no-backup' }; // branch exists but nothing in it yet

  // 1. Database: download to a side file, VALIDATE it opens and answers the
  //    query the app boots on, then atomically move it into place. A corrupt
  //    or foreign backup must never replace a container that still works.
  const dbBlob = await gh(`/repos/${repo}/git/blobs/${dbEntry.sha}`);
  if (dbBlob.status !== 200 || !dbBlob.data.content) throw new Error('database blob is unreadable');
  const dbBytes = Buffer.from(dbBlob.data.content, 'base64');

  const tmpPath = `${config.dbPath}.remote`;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.writeFileSync(tmpPath, dbBytes);
  let verified = false;
  let verifyHandle = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    verifyHandle = new DatabaseSync(tmpPath, { readOnly: true });
    verifyHandle.prepare('SELECT COUNT(*) AS n FROM exams').get();
    verified = true;
  } catch {
    verified = false;
  } finally {
    try { if (verifyHandle) verifyHandle.close(); } catch { /* already closed */ }
  }
  if (!verified) {
    fs.rmSync(tmpPath, { force: true });
    return { status: 'error', error: 'the backed-up database failed verification and was NOT applied' };
  }
  fs.renameSync(tmpPath, config.dbPath);

  // 2. Uploads: merge, never clobber. A file this container already has (an
  //    upload from this boot) is the newer one; only missing files land.
  let uploadsFiles = 0;
  const uploadsEntry = entry('uploads.zip');
  if (uploadsEntry) {
    const zipBlob = await gh(`/repos/${repo}/git/blobs/${uploadsEntry.sha}`);
    if (zipBlob.status === 200 && zipBlob.data.content) {
      const zipBytes = Buffer.from(zipBlob.data.content, 'base64');
      try {
        const entries = readZip(zipBytes);
        fs.mkdirSync(config.uploadsDir, { recursive: true });
        for (const [name, data] of Object.entries(entries)) {
          const dest = safeUploadTarget(config.uploadsDir, name);
          if (!dest) continue;
          if (fs.existsSync(dest)) continue; // local wins
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, data);
          uploadsFiles++;
        }
      } catch (err) {
        // The database is already restored and valid; a broken zip costs the
        // figure files, not the boot.
        console.warn('[backup] restored the database but the uploads archive is unreadable', { error: err.message });
      }
    }
  }

  return { status: 'restored', dbBytes: dbBytes.length, uploadsFiles };
}

/**
 * Restore BEFORE the app loads. Synchronous, because requiring routes/api
 * opens (and on a fresh container CREATES) the database a few lines below —
 * an async restore would lose that race. Implemented by spawning the worker
 * so the download can await while this process's module load stays blocked.
 */
function restoreSync() {
  if (!isConfigured()) {
    lastRestore = { status: 'not-configured', at: new Date().toISOString() };
    return lastRestore;
  }
  const r = spawnSync(process.execPath, [WORKER], {
    encoding: 'utf8',
    timeout: 90000,
    env: process.env,
  });
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
  let outcome = null;
  try { outcome = JSON.parse(lines[lines.length - 1]); } catch { /* crashed before printing */ }
  if (!outcome) {
    outcome = {
      status: 'error',
      error: String(r.stderr || '').trim().slice(-400) || `restore worker exited ${r.status}`,
    };
  }
  lastRestore = { ...outcome, at: new Date().toISOString() };
  if (outcome.status === 'restored') {
    console.log(`[backup] restored from GitHub: database ${Math.round(outcome.dbBytes / 1024)} KB, ${outcome.uploadsFiles} uploaded file(s)`);
  } else if (outcome.status === 'error') {
    console.error(`[backup] restore FAILED: ${outcome.error} — this boot starts empty; the next backup attempt will not lose the remote copy`);
  } else if (outcome.status !== 'not-configured') {
    console.log(`[backup] nothing to restore (${outcome.status})`);
  }
  return lastRestore;
}

// ── backup ──────────────────────────────────────────────────────────────

/** Zip the whole uploads tree (figures, photos, voice notes) for shipping. */
function zipUploads(dir) {
  const entries = [];
  const walk = (rel) => {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const name = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(name);
      else if (d.isFile()) {
        try { entries.push({ name, data: fs.readFileSync(path.join(dir, name)) }); } catch { /* unreadable now */ }
      }
    }
  };
  if (dir && fs.existsSync(dir)) walk('');
  return buildZip(entries);
}

/**
 * Push the current database + uploads to the backup branch as one parentless
 * commit, force-moving the branch. Never throws: failure is recorded and
 * logged so the interval keeps trying; the app must not die because GitHub
 * had a bad minute.
 */
async function backupNow() {
  if (!isConfigured()) return { ok: false, status: 'not-configured' };
  if (backupRunning) return { ok: false, status: 'busy' };
  backupRunning = true;
  try {
    const repo = repoName();
    const { branch } = config.backup;

    // VACUUM INTO writes a consistent snapshot from the live connection —
    // safe while requests are being served, unlike copying a WAL database
    // file mid-write. Required lazily: at restore time this module must not
    // be the thing that opens the database.
    const db = require('../db');
    const snapPath = `${config.dbPath}.vacuum`;
    fs.rmSync(snapPath, { force: true });
    db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
    const dbBuf = fs.readFileSync(snapPath);
    fs.rmSync(snapPath, { force: true });

    if (dbBuf.length > MAX_BLOB_BYTES) {
      throw new Error(`database snapshot is ${Math.round(dbBuf.length / 1048576)} MB — over GitHub's blob limit; nothing was pushed`);
    }
    const uploadsBuf = zipUploads(config.uploadsDir);
    const uploadsTooLarge = uploadsBuf.length > MAX_BLOB_BYTES;
    if (uploadsTooLarge) {
      console.error(`[backup] uploads archive is ${Math.round(uploadsBuf.length / 1048576)} MB — over GitHub's blob limit; shipping the DATABASE ONLY`);
    }

    // blobs → tree (no base_tree: a root tree for a parentless commit)
    const treeEntries = [];
    const dbBlob = await gh('/repos/' + repo + '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: dbBuf.toString('base64'), encoding: 'base64' }),
    });
    if (dbBlob.status !== 201 || !dbBlob.data.sha) throw new Error('database blob was rejected');
    treeEntries.push({ path: 'exams.db', mode: '100644', type: 'blob', sha: dbBlob.data.sha });

    if (!uploadsTooLarge) {
      const zipBlob = await gh('/repos/' + repo + '/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content: uploadsBuf.toString('base64'), encoding: 'base64' }),
      });
      if (zipBlob.status !== 201 || !zipBlob.data.sha) throw new Error('uploads blob was rejected');
      treeEntries.push({ path: 'uploads.zip', mode: '100644', type: 'blob', sha: zipBlob.data.sha });
    }

    const tree = await gh(`/repos/${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ tree: treeEntries }),
    });
    if (tree.status !== 201 || !tree.data.sha) throw new Error('backup tree was rejected');

    const commit = await gh(`/repos/${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `auto backup ${new Date().toISOString()}`,
        tree: tree.data.sha,
        parents: [], // parentless on purpose: history never grows (see header)
      }),
    });
    if (commit.status !== 201 || !commit.data.sha) throw new Error('backup commit was rejected');

    const refPath = `/repos/${repo}/git/ref/heads/${branch}`;
    const ref = await gh(refPath);
    if (ref.status === 404) {
      const created = await gh(`/repos/${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.data.sha }),
      });
      if (created.status !== 201) throw new Error('backup branch could not be created');
    } else {
      const moved = await gh(refPath, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.data.sha, force: true }),
      });
      if (moved.status !== 200) throw new Error('backup branch could not be updated');
    }

    lastBackup = {
      ok: true,
      at: new Date().toISOString(),
      dbBytes: dbBuf.length,
      uploadsBytes: uploadsTooLarge ? null : uploadsBuf.length,
      uploadsTooLarge,
    };
    console.log(
      `[backup] saved ${Math.round(dbBuf.length / 1024)} KB db + ` +
      (uploadsTooLarge ? 'NO uploads (too large)' : `${Math.round(uploadsBuf.length / 1024)} KB uploads`) +
      ` → ${repo}@${branch}`
    );
    return lastBackup;
  } catch (err) {
    lastBackup = { ok: false, error: err.message, at: new Date().toISOString() };
    console.error(`[backup] push FAILED: ${err.message}`);
    return lastBackup;
  } finally {
    backupRunning = false;
  }
}

/**
 * Push once immediately (whatever boot restored or seeded is captured before
 * the first incident), then on the interval. The timer is unref'd so it can
 * never hold the process open.
 */
function startBackupLoop() {
  if (!isConfigured()) {
    console.log('[backup] off — set BACKUP_GITHUB_TOKEN and BACKUP_GITHUB_REPO to survive redeploys on a diskless plan');
    return null;
  }
  console.log(`[backup] on → ${config.backup.repo}@${config.backup.branch} every ${Math.round(config.backup.intervalMs / 1000)}s`);
  backupNow();
  const timer = setInterval(() => { backupNow(); }, config.backup.intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

/**
 * One final backup when Render sends SIGTERM before replacing the container.
 * Registering a handler replaces Node's default exit, so both paths below
 * exit explicitly — with a deadline, because a hung flush must not eat the
 * whole shutdown window.
 */
function flushOnShutdown() {
  process.on('SIGTERM', () => {
    let exiting = false;
    const done = () => {
      if (exiting) return;
      exiting = true;
      process.exit(0);
    };
    if (isConfigured()) console.log('[backup] final backup before shutdown…');
    backupNow().then(done, done);
    setTimeout(done, 8000).unref();
  });
}

module.exports = {
  isConfigured,
  getStatus,
  runRestore,
  restoreSync,
  backupNow,
  startBackupLoop,
  flushOnShutdown,
  zipUploads,
};
