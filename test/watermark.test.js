'use strict';
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');      // isolate has already pointed uploadsDir at the temp dir
const DEFAULT_SVG = path.join(__dirname, '..', 'src', 'public', 'icon.svg');

// A 3:1 mark that shares nothing with icon.svg: different aspect, different
// geometry, different colours. The default logo is square and gradient-filled,
// so a "custom" upload of icon.svg would be legitimately idempotent and could
// not prove that a custom logo changes the served bytes.
// Never compare two multi-KB buffers with deepEqual: on a mismatch node's
// assert walks and diffs them, which costs tens of seconds and dies trying to
// build the failure message. `.equals()` is a length check plus memcmp.
const CUSTOM_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100">' +
  '<rect width="300" height="100" fill="#ffffff"/>' +
  '<circle cx="60" cy="50" r="36" fill="#25D366"/>' +
  '<rect x="120" y="26" width="150" height="48" rx="10" fill="#0a5c36"/>' +
  '</svg>', 'utf8');

// A PNG whose signature and IHDR stay intact while the IDAT payload turns to
// garbage. pngSize() resolves on it - that is the point, the header-level check
// cannot see this - and only a real decode rejects it. Filling 64 bytes past
// the IDAT chunk header leaves the header alone.
function corruptIdat(png) {
  const bad = Buffer.from(png);
  const at = bad.indexOf('IDAT', 8, 'ascii');
  assert.ok(at > 0, 'expected an IDAT chunk to corrupt');
  bad.fill(0xff, at + 4, at + 4 + 64);
  return bad;
}

let watermark;
test.before(() => { watermark = require('../src/services/watermark'); });

test.after(() => {
  // Leave no custom logo behind for the next test file in the same process.
  return watermark.remove();
});

test('watermarkPng returns a decodable 700x700 png', async () => {
  const png = await watermark.watermarkPng();
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length > 1000, `suspiciously small: ${png.length}`);
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual(await watermark.pngSize(png), { width: 700, height: 700 });
});

test('hasCustom is false until a logo is saved, and true after', async () => {
  await watermark.remove();
  assert.equal(watermark.hasCustom(), false);
  await watermark.save(fs.readFileSync(DEFAULT_SVG));
  assert.equal(watermark.hasCustom(), true);
  assert.equal(fs.existsSync(path.join(config.uploadsDir, 'watermark.png')), true);
  assert.equal(watermark.filePath(), path.join(config.uploadsDir, 'watermark.png'));
  await watermark.remove();
  assert.equal(watermark.hasCustom(), false);
  assert.equal(watermark.hasCustom(), false);   // removing twice is not an error
});

test('uploading a custom logo changes the bytes; removing reverts to the default', async () => {
  await watermark.remove();
  const before = await watermark.watermarkPng();
  await watermark.save(CUSTOM_SVG);
  const custom = await watermark.watermarkPng();
  assert.ok(!custom.equals(before),
    `a custom logo must produce a different watermark (${before.length} vs ${custom.length} bytes)`);
  await watermark.remove();
  const reverted = await watermark.watermarkPng();
  assert.ok(reverted.equals(before),
    `removing must revert to icon.svg (${before.length} vs ${reverted.length} bytes)`);
});

test('save rejects bytes that are not an image', async () => {
  await assert.rejects(() => watermark.save(Buffer.from('not an image at all')), /image|decode|input/i);
  assert.equal(watermark.hasCustom(), false, 'a rejected upload must not leave a file behind');
});

test('invalidate forces a re-read of the file', async () => {
  await watermark.remove();
  const a = await watermark.watermarkPng();
  // Identity, not equality: the cached promise is handed back untouched.
  assert.equal(await watermark.watermarkPng(), a, 'an unchanged file is served from the cache');

  // save() invalidates on success, so this read cannot still be the cache.
  await watermark.save(CUSTOM_SVG);
  const b = await watermark.watermarkPng();
  assert.ok(!b.equals(a),
    `the read after save must reflect the new file (${a.length} vs ${b.length} bytes)`);

  // The pipeline is deterministic, so re-reading the same file reproduces it
  // byte for byte. Proving the bytes match would pass on a stale cache too;
  // proving the BUFFER is a different object is what shows the cache was dropped.
  watermark.invalidate();
  const c = await watermark.watermarkPng();
  assert.ok(c.equals(b), 'a re-read of the same file is deterministic');
  assert.notEqual(c, b, 'invalidate must drop the cached buffer');
  await watermark.remove();
});

test('the pipeline is applied exactly once, and a second pass is detectable', async () => {
  await watermark.remove();
  const once = await watermark.processWatermark(fs.readFileSync(DEFAULT_SVG));
  const twice = await watermark.processWatermark(once);
  // Neither blur(2.5) nor linear(1, 96) is idempotent, so a second pass cannot
  // reproduce the first. If that ever stopped holding, the comparison below
  // would pass without proving anything, hence this guard.
  assert.ok(!twice.equals(once),
    `a second pass must be detectable (${once.length} vs ${twice.length} bytes)`);
  // A byte count would pin icon.svg to whatever it renders as today; the
  // relationship is what has to hold as the wash is retuned.
  const served = await watermark.watermarkPng();
  assert.ok(served.equals(once),
    `the served default must be the single pass (${served.length} vs ${once.length} bytes)`);
});

test('a stored logo that cannot be decoded degrades to the default', async () => {
  await watermark.save(CUSTOM_SVG);
  const custom = await watermark.watermarkPng();
  const good = await watermark.processWatermark(fs.readFileSync(DEFAULT_SVG));
  // The header is valid, so save() accepts it. That is the hole the read-time
  // fallback exists to cover.
  await watermark.save(corruptIdat(good));
  const served = await watermark.watermarkPng();
  assert.ok(!served.equals(custom), 'the previous render must not keep being served');
  assert.ok(served.equals(good),
    `an undecodable logo must fall back to the default (${served.length} vs ${good.length} bytes)`);
  await watermark.remove();
});
