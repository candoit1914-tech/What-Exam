'use strict';

// The boot warning that protects a live database from being wiped only helps
// if it fires in the shape that actually bit us: DB_PATH/UPLOADS_DIR set, but
// resolving onto the container filesystem because no disk is mounted. These
// tests pin the mount-table arithmetic that decides that.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseMountPoints, onPersistentDisk, ephemeralPaths } = require('../src/services/storageHealth');

// A Render container WITHOUT a disk: everything lives under the root overlay.
const NO_DISK = [
  'overlay / overlay rw,relatime 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec 0 0',
  'tmpfs /dev shm rw,nosuid,nodev 0 0',
].join('\n');

// The same container WITH a disk mounted at the documented path.
const WITH_DISK = NO_DISK + '\n' +
  '/dev/sdb1 /opt/render/project/src/data ext4 rw,relatime 0 0';

test('without a mounted disk, the Render data paths are ephemeral', () => {
  const risk = ephemeralPaths(
    ['/opt/render/project/src/data/exams.db', '/opt/render/project/src/data/uploads'],
    NO_DISK
  );
  assert.strictEqual(risk.length, 2, 'both paths must be flagged: this container dies on redeploy');
});

test('with the disk mounted, the same paths are safe', () => {
  const risk = ephemeralPaths(
    ['/opt/render/project/src/data/exams.db', '/opt/render/project/src/data/uploads'],
    WITH_DISK
  );
  assert.deepStrictEqual(risk, [], 'a mounted disk at the data path is exactly the healthy layout');
});

test('a disk mounted at some OTHER path does not save a database outside it', () => {
  const mounts = NO_DISK + '\n/dev/sdb1 /opt/render/other ext4 rw 0 0';
  const risk = ephemeralPaths(['/opt/render/project/src/data/exams.db'], mounts);
  assert.strictEqual(risk.length, 1,
    'DB_PATH must not silently point outside the mounted disk - that is the misconfiguration that wiped data');
});

test('a path merely sharing a name prefix with the disk mount is still ephemeral', () => {
  const mounts = NO_DISK + '\n/dev/sdb1 /opt/render/project/src/data ext4 rw 0 0';
  // /opt/render/project/src/database is NOT under .../data - prefix matching
  // must be segment-wise, not string-wise.
  assert.strictEqual(onPersistentDisk('/opt/render/project/src/database', parseMountPoints(mounts)), false);
  assert.strictEqual(onPersistentDisk('/opt/render/project/src/datax', parseMountPoints(mounts)), false);
});

test('an empty or unknown mount table never cries wolf', () => {
  assert.deepStrictEqual(ephemeralPaths(['/any/path'], ''), []);
  assert.deepStrictEqual(ephemeralPaths([''], NO_DISK), [], 'empty path is nothing to judge');
});

test('mount points with octal escapes are decoded before matching', () => {
  const mounts = NO_DISK + '\n/dev/sdb1 /opt/render/my\\040disk ext4 rw 0 0';
  assert.strictEqual(onPersistentDisk('/opt/render/my disk/exams.db', parseMountPoints(mounts)), true);
});

test('the root mount itself never counts as persistence', () => {
  const points = parseMountPoints('/dev/sda / ext4 rw 0 0');
  assert.strictEqual(onPersistentDisk('/anything/at/all', points), false);
});
