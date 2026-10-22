'use strict';

/**
 * Whether a path lives on a PERSISTENT mount, for the boot-time data-loss
 * warning in server.js.
 *
 * The old warning only checked that DB_PATH/UPLOADS_DIR were *set*. That
 * missed the deployment that actually destroyed data: the variables were set
 * (so the warning stayed silent) but pointed inside the container filesystem
 * because no disk was ever mounted — or the disk was mounted at some other
 * path. Every deploy then wiped the database and the app re-seeded, which
 * looks like a routine boot in the logs.
 *
 * The truth is in /proc/mounts: every mounted filesystem lists its mount
 * point, and a file path is persistent exactly when some mount point other
 * than the root filesystem ("/", the ephemeral overlay on Render) is a
 * prefix of it. Reading that is a plain-text check — no native modules, no
 * root privileges needed.
 *
 * Outside Linux (no /proc/mounts — local dev on Windows/macOS) the answer is
 * "unknown", reported as persistent: a developer's ./data is not at risk of a
 * Render redeploy, and a false DATA LOSS banner on every local boot teaches
 * people to ignore the real one.
 */

const fs = require('fs');

const PROC_MOUNTS = '/proc/mounts';

/**
 * Parse /proc/mounts text into mount point paths. The second whitespace
 * field of each line is the mount point, with octal escapes (\040 for a
 * space) that must be decoded.
 */
function parseMountPoints(mountsText) {
  if (!mountsText) return [];
  const points = [];
  for (const line of String(mountsText).split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const point = fields[1].replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    if (point) points.push(point);
  }
  return points;
}

/**
 * Is `dir` covered by a mounted filesystem other than the root overlay?
 *
 * The longest mount point that is a prefix of `dir` decides: on Render with a
 * disk mounted at /opt/render/project/src/data, that mount wins for the DB
 * file under it, while the same path without the disk falls back to "/" —
 * the ephemeral container filesystem.
 */
function onPersistentDisk(dir, mountPoints) {
  const normalized = String(dir || '').replace(/\/+$/, '');
  if (!normalized) return true; // nothing to judge — don't cry wolf
  let best = '';
  for (const point of mountPoints) {
    const p = point.replace(/\/+$/, '') || '/';
    const covered = p === '/' || normalized === p || normalized.startsWith(`${p}/`);
    if (covered && p.length > best.length) best = p;
  }
  if (!best) return true; // no usable mount table — unknown, assume fine
  return best !== '/';
}

/**
 * The subset of `paths` that sits on the ephemeral container filesystem.
 * Returns [] when the mount table cannot be read (non-Linux, or unreadable),
 * i.e. "no evidence of risk" rather than a guess in either direction.
 */
function ephemeralPaths(paths, mountsText) {
  let text = mountsText;
  if (text === undefined) {
    try {
      text = fs.readFileSync(PROC_MOUNTS, 'utf8');
    } catch {
      return [];
    }
  }
  const points = parseMountPoints(text);
  if (!points.length) return [];
  return paths.filter((p) => !onPersistentDisk(p, points));
}

module.exports = { parseMountPoints, onPersistentDisk, ephemeralPaths };
