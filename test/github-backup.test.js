'use strict';

// GitHub as the disk Render free tier refuses to sell: every backup is a
// parentless commit force-moved onto the backup branch, and boot pulls the
// last one back BEFORE any app module opens the database. These tests pin the
// full round trip with nothing stubbed but fetch: what bytes leave (a real
// SQLite snapshot + a real zip of uploads), what lands on a fresh container
// (verified database, merged uploads, traversal names rejected), and what is
// refused (a local database that still has data; a corrupt remote snapshot).

require('./helpers/isolate');

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const config = require('../src/config');
const db = require('../src/db');
const backup = require('../src/services/backup');
const { buildZip, readZip } = require('../src/services/zip');

const isolateFetch = global.fetch;
const origBackup = { ...config.backup };
const origDbPath = config.dbPath;
const origUploadsDir = config.uploadsDir;

afterEach(() => {
  global.fetch = isolateFetch;
  config.backup = { ...origBackup };
  config.dbPath = origDbPath;
  config.uploadsDir = origUploadsDir;
});

function ghResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-exam-backup-'));
  return { dir, dbPath: path.join(dir, 'exams.db'), uploadsDir: path.join(dir, 'uploads') };
}

function sqliteFileWithExam(title) {
  const p = path.join(os.tmpdir(), `la-exam-remote-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const h = new DatabaseSync(p);
  h.exec('CREATE TABLE exams (id INTEGER PRIMARY KEY, title TEXT)');
  h.prepare('INSERT INTO exams (title) VALUES (?)').run(title);
  h.close();
  const bytes = fs.readFileSync(p);
  fs.rmSync(p, { force: true });
  return bytes;
}

function examTitles(dbPath) {
  const h = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return h.prepare('SELECT title FROM exams ORDER BY id').all().map((r) => r.title);
  } finally {
    h.close();
  }
}

/** Outgoing-side stub: records every API call, serves ref/tree/commit/blobs. */
function stubOutgoingGitHub({ refStatus = 404 } = {}) {
  const calls = [];
  const blobs = new Map();
  let blobCount = 0;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ url: u, method, body: init.body, headers: init.headers });
    if (method === 'POST' && u.endsWith('/git/blobs')) {
      const body = JSON.parse(init.body);
      const sha = `blob${++blobCount}`;
      blobs.set(sha, Buffer.from(body.content, 'base64'));
      return ghResponse(201, { sha });
    }
    if (method === 'POST' && u.endsWith('/git/trees')) return ghResponse(201, { sha: 'treesha' });
    if (method === 'POST' && u.endsWith('/git/commits')) return ghResponse(201, { sha: 'commitsha' });
    if (method === 'GET' && u.includes('/git/ref/heads/')) {
      return refStatus === 404 ? ghResponse(404, { message: 'Not Found' }) : ghResponse(200, { object: { sha: 'oldsha' } });
    }
    if (method === 'PATCH') return ghResponse(200, { object: { sha: JSON.parse(init.body).sha } });
    if (method === 'POST' && u.endsWith('/git/refs')) return ghResponse(201, { ref: JSON.parse(init.body).ref });
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
  return { calls, blobs };
}

/** Incoming-side stub: serves one branch state, a db blob, an optional zip. */
function stubRestoreGitHub({ refStatus = 200, dbBytes, zipEntries = null } = {}) {
  const calls = [];
  const tree = [{ path: 'exams.db', type: 'blob', sha: 'dbblob' }];
  if (zipEntries) tree.push({ path: 'uploads.zip', type: 'blob', sha: 'zipblob' });
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ url: u, method });
    if (u.includes('/git/ref/heads/')) {
      return refStatus === 404 ? ghResponse(404, { message: 'Not Found' }) : ghResponse(200, { object: { sha: 'r1' } });
    }
    if (u.includes('/git/commits/')) return ghResponse(200, { tree: { sha: 't1' } });
    if (u.includes('/git/trees/')) return ghResponse(200, { tree });
    if (u.includes('/git/blobs/dbblob')) {
      return ghResponse(200, { content: Buffer.from(dbBytes).toString('base64'), encoding: 'base64' });
    }
    if (u.includes('/git/blobs/zipblob')) {
      return ghResponse(200, { content: buildZip(zipEntries).toString('base64'), encoding: 'base64' });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
  return { calls };
}

function useBackupEnv() {
  config.backup = { token: 'tok123', repo: 'me/private-backup', branch: 'backup', intervalMs: 60000 };
}

test('isConfigured is off by default and normalizes a pasted repo URL', async () => {
  assert.equal(backup.isConfigured(), false);
  config.backup = { token: '', repo: 'me/private-backup', branch: 'backup', intervalMs: 60000 };
  assert.equal(backup.isConfigured(), false, 'token missing');
  config.backup = { token: 'tok', repo: '', branch: 'backup', intervalMs: 60000 };
  assert.equal(backup.isConfigured(), false, 'repo missing');
  // Someone pastes the browser URL into the env var — still works, proven by
  // the API call the service actually makes (normalized at use time).
  config.backup = {
    token: 'tok',
    repo: 'https://github.com/me/private-backup.git',
    branch: 'backup',
    intervalMs: 60000,
  };
  assert.equal(backup.isConfigured(), true);
  const sb = makeSandbox();
  config.dbPath = sb.dbPath;
  config.uploadsDir = sb.uploadsDir;
  const { calls } = stubRestoreGitHub({ refStatus: 404, dbBytes: Buffer.alloc(0) });
  await backup.runRestore();
  assert.ok(calls[0].url.startsWith('https://api.github.com/repos/me/private-backup/git/ref/'), calls[0].url);
});

test('restoreSync is a no-op without configuration (no child process spawned)', () => {
  const r = backup.restoreSync();
  assert.equal(r.status, 'not-configured');
  assert.equal(backup.getStatus().lastRestore.status, 'not-configured');
});

test('backupNow ships a real SQLite snapshot and the uploads zip as a parentless commit, creating the branch', async () => {
  useBackupEnv();
  db.prepare("INSERT INTO exams (title, duration_minutes) VALUES ('Backup me', 30)").run();
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadsDir, 'fig-a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const { calls, blobs } = stubOutgoingGitHub({ refStatus: 404 });
  const r = await backup.backupNow();
  assert.equal(r.ok, true, r.error);

  // Two blobs: the database and the uploads archive.
  const blobCalls = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/git/blobs'));
  assert.equal(blobCalls.length, 2);
  assert.equal(blobCalls[0].headers.Authorization, 'Bearer tok123', 'every call is authenticated');

  // The database blob is a valid SQLite file holding the row this process wrote.
  const dbContent = JSON.parse(blobCalls[0].body);
  assert.equal(dbContent.encoding, 'base64');
  const snapBytes = Buffer.from(dbContent.content, 'base64');
  assert.equal(snapBytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  const snapPath = path.join(os.tmpdir(), `la-exam-snap-${process.pid}.db`);
  fs.writeFileSync(snapPath, snapBytes);
  assert.deepEqual(examTitles(snapPath).filter((t) => t === 'Backup me'), ['Backup me']);
  fs.rmSync(snapPath, { force: true });

  // The uploads blob round-trips through the same zip reader the restore uses.
  const zipContent = JSON.parse(blobCalls[1].body);
  const entries = readZip(Buffer.from(zipContent.content, 'base64'));
  assert.equal(entries['fig-a.png'][0], 0x89);
  assert.equal(blobs.size, 2);

  // Parentless commit (history can never grow), branch created on first push.
  const commitCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'));
  assert.deepEqual(JSON.parse(commitCall.body).parents, []);
  const refCreate = calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/refs'));
  assert.equal(JSON.parse(refCreate.body).ref, 'refs/heads/backup');
});

test('subsequent backups force-move the existing branch instead of creating one', async () => {
  useBackupEnv();
  const { calls } = stubOutgoingGitHub({ refStatus: 200 });
  const r = await backup.backupNow();
  assert.equal(r.ok, true, r.error);
  assert.equal(calls.some((c) => c.method === 'POST' && c.url.endsWith('/git/refs')), false, 'no branch creation');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'branch was moved');
  const body = JSON.parse(patch.body);
  assert.equal(body.sha, 'commitsha');
  assert.equal(body.force, true, 'force: the new commit is parentless');
});

test('runRestore reports no-backup when the branch does not exist yet', async () => {
  useBackupEnv();
  const sb = makeSandbox();
  config.dbPath = sb.dbPath;
  config.uploadsDir = sb.uploadsDir;
  const { calls } = stubRestoreGitHub({ refStatus: 404, dbBytes: Buffer.alloc(0) });
  const r = await backup.runRestore();
  assert.equal(r.status, 'no-backup');
  assert.equal(calls.length, 1, 'only the ref was consulted');
});

test('runRestore lands the database and merges uploads without clobbering local files or escaping the dir', async () => {
  useBackupEnv();
  const sb = makeSandbox();
  config.dbPath = sb.dbPath;
  config.uploadsDir = sb.uploadsDir;
  fs.mkdirSync(sb.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(sb.uploadsDir, 'existing.png'), 'old-local-content');

  stubRestoreGitHub({
    dbBytes: sqliteFileWithExam('Remote Exam'),
    zipEntries: [
      { name: 'existing.png', data: Buffer.from('new-remote-content') },
      { name: 'fig-remote.png', data: Buffer.from([0x89, 0x50]) },
      { name: '../escape.png', data: Buffer.from('evil') },
    ],
  });

  const r = await backup.runRestore();
  assert.equal(r.status, 'restored', r.error);
  assert.deepEqual(examTitles(sb.dbPath), ['Remote Exam']);
  assert.equal(fs.existsSync(`${sb.dbPath}.remote`), false, 'the download side-file is gone');
  assert.equal(fs.readFileSync(path.join(sb.uploadsDir, 'existing.png'), 'utf8'), 'old-local-content',
    'a file this container already has is never overwritten');
  assert.deepEqual([...fs.readFileSync(path.join(sb.uploadsDir, 'fig-remote.png'))], [0x89, 0x50]);
  assert.equal(fs.existsSync(path.join(sb.dir, 'escape.png')), false, 'traversal name never lands outside uploads');
  assert.equal(r.uploadsFiles, 1);
});

test('runRestore refuses to replace a container that already has data', async () => {
  useBackupEnv();
  const sb = makeSandbox();
  config.dbPath = sb.dbPath;
  config.uploadsDir = sb.uploadsDir;
  const h = new DatabaseSync(sb.dbPath);
  h.exec('CREATE TABLE exams (id INTEGER PRIMARY KEY, title TEXT)');
  h.prepare('INSERT INTO exams (title) VALUES (?)').run('This boot already imported');
  h.close();

  const { calls } = stubRestoreGitHub({ dbBytes: sqliteFileWithExam('Remote Exam') });
  const r = await backup.runRestore();
  assert.equal(r.status, 'local-data');
  assert.deepEqual(examTitles(sb.dbPath), ['This boot already imported']);
  assert.equal(calls.length, 0, 'local data is decided before any network call');
});

test('a corrupt remote snapshot is rejected and the local database survives untouched', async () => {
  useBackupEnv();
  const sb = makeSandbox();
  config.dbPath = sb.dbPath;
  config.uploadsDir = sb.uploadsDir;
  fs.writeFileSync(sb.dbPath, 'this is not sqlite');

  stubRestoreGitHub({ dbBytes: Buffer.from('also not sqlite') });
  const r = await backup.runRestore();
  assert.equal(r.status, 'error');
  assert.match(r.error, /verification/);
  assert.equal(fs.readFileSync(sb.dbPath, 'utf8'), 'this is not sqlite', 'local file untouched');
  assert.equal(fs.existsSync(`${sb.dbPath}.remote`), false, 'rejected download removed');
});
