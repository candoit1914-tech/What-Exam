'use strict';

// The one watermark, used by the print page and the .docx alike.
//
// Storage: a single fixed filename, holding the upload EXACTLY as it arrived.
// The pipeline therefore runs once, in watermarkPng(), on read - the bytes on
// disk are an internal input, never served, so the .png extension on an SVG
// upload is a label for humans browsing uploadsDir and nothing more. The
// file's EXISTENCE is the setting, so there is no column, no migration and no
// seed. uploadsDir is already on Render's persistent disk (render.yaml mounts
// it and sets UPLOADS_DIR), so the logo survives deploys.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const config = require('../config');

const FILE = 'watermark.png';
const SIZE = 700;

// Re-encoded to a 256-colour palette: a washed-out logo needs almost no
// colour depth, and a 700px mark lands at 40-47 KB instead of a few hundred,
// which is what makes it reasonable to inline as a data: URI in every
// printable page.
const PNG = { palette: true, quality: 90, effort: 10, compressionLevel: 9 };

// The default is vector, so it rasterises crisply at watermark scale.
// oktek-logo.png is deliberately not the default: 2.3 MB, and it is the
// certificate's partner mark, not the app's.
function defaultSource() {
  return path.join(__dirname, '..', 'public', 'icon.svg');
}

/**
 * Process any decodable image into the finished watermark.
 *
 *   decode -> trim -> square box -> flatten on white -> blur -> lift toward white
 *
 * trim() is not cosmetic: without it a 3:1 letterboxed upload keeps the letter
 * box, and the measured ink centre for icon.svg is (352, 328) instead of
 * (350, 350) - a visibly high watermark on every page.
 *
 * blur(2.5) is baked in because Word's watermark feature exposes no blur
 * control. The remaining fade is `linear(1, 96)`, applied in the pixels
 * because gain/blacklevel in the VML shape are honoured by Word and
 * LibreOffice but not by every consumer - a renderer that ignores the
 * washout must still show a pale, illegible-either-way mark.
 */
async function processWatermark(input) {
  return sharp(input, { density: 384 })
    .trim({ threshold: 10 })
    .resize({
      width: SIZE,
      height: SIZE,
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .flatten({ background: '#ffffff' })
    .blur(2.5)
    .linear(1, 96)
    .png(PNG)
    .toBuffer();
}

// The custom logo when one is stored, otherwise the default. `custom` rides
// along with the bytes so a later failure can be attributed: a broken upload
// must degrade, a broken default is a real error.
async function readSource() {
  try {
    return { custom: true, buffer: await fsp.readFile(filePath()) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { custom: false, buffer: await fsp.readFile(defaultSource()) };
  }
}

function filePath() {
  return path.join(config.uploadsDir, FILE);
}

async function renderWatermark() {
  const source = await readSource();
  try {
    return await processWatermark(source.buffer);
  } catch (err) {
    if (!source.custom) throw err;
    // save() only checks the header, so a logo whose IHDR is valid and whose
    // pixels are not can still get stored. Throwing here broke the print page
    // and every .docx on every call, while hasCustom() went on reporting the
    // setting as on. Fall back to the default and name the file to delete.
    console.warn(
      `[watermark] ${filePath()} could not be processed (${err.message}); ` +
      'falling back to the default logo. Delete that file to clear this.'
    );
    return processWatermark(await fsp.readFile(defaultSource()));
  }
}

// A single cached promise, the pattern src/services/certificate.js:10 already
// uses. Failures are NOT cached: a transient decode error must not poison the
// process until restart. A successful fallback IS cached, so a broken upload
// costs one wasted decode and one warning, not one per request.
let cached = null;

async function watermarkPng() {
  if (!cached) {
    cached = renderWatermark().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/**
 * Store an upload, untouched, as the app's watermark source.
 *
 * The bytes are written verbatim; the pipeline runs once, in watermarkPng(), on
 * read. Processing here as well is what made the logo come out double-washed:
 * `blur(2.5)` is not idempotent and neither is `linear(1, 96)`, so the default
 * icon.svg measured 46,648 bytes through one pass and 23,455 through two -
 * visibly fainter than intended.
 *
 * pngSize() is the gate, and it is a header-level check rather than a decode: it
 * rejects bytes sharp cannot recognise at all, but an image whose header lies
 * about its contents still passes and still fails when read. That is the
 * deliberate trade - a full decode here would double the cost of every upload
 * and would be a memory-exhaustion vector on attacker-chosen bytes - and
 * watermarkPng() degrades to the default when it meets one.
 *
 * Storing raw is also what keeps user-supplied markup away from a browser: the
 * stored bytes are an internal input, never served, so this function
 * deliberately returns nothing - handing the raw buffer back to a caller would
 * put un-rasterised markup one careless `res.send()` away from the page. The
 * stored filename is server-chosen, never the client's.
 *
 * @param {Buffer} buffer the uploaded image, in any format sharp can decode
 * @returns {Promise<void>}
 */
async function save(buffer) {
  await pngSize(buffer);
  const next = saving.then(() => swapIn(buffer));
  saving = next.catch(() => {});      // one failed upload must not poison the chain
  return next;
}

// Serialised. The target is a single fixed file, so concurrent uploads have
// exactly one winner between them - but on Windows a second rename onto that
// path fails with EPERM while the first is still in flight, and the loser reached
// the admin as a failed upload. A short chain makes "last save wins" true rather
// than merely likely. remove() is not queued: it is one unlink, and it only ever
// runs on its own request.
let saving = Promise.resolve();

async function swapIn(buffer) {
  await fsp.mkdir(config.uploadsDir, { recursive: true });
  // A temp name keyed only on the pid is shared by every concurrent upload in
  // the process: two saves interleaved their writeFile calls on one path and
  // then raced the renames, which tore the stored logo into a blend of both
  // uploads and handed one caller an ENOENT for a save that had in fact landed.
  // A per-call name removes the collision, and the .tmp suffix keeps the scratch
  // file unmistakably not-a-watermark - only the exact basename is ever read.
  const tmp = `${filePath()}.${randomUUID()}.tmp`;
  try {
    // Write-then-rename so a reader never sees a half-written file.
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, filePath());
  } finally {
    // Either step can fail, and without this the scratch file outlives the
    // request and piles up in uploadsDir.
    await fsp.rm(tmp, { force: true });
  }
  invalidate();
}

async function remove() {
  try {
    await fsp.unlink(filePath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  invalidate();
}

function hasCustom() {
  try {
    return fs.statSync(filePath()).size > 0;
  } catch {
    return false;
  }
}

function invalidate() {
  cached = null;
}

/**
 * Read the IHDR dimensions, which sharp does without decoding pixels.
 *
 * Doubles as save()'s validation step: it throws for bytes sharp cannot
 * recognise, and it is the only check save() performs.
 *
 * @param {Buffer} buffer any image format sharp can inspect
 * @returns {Promise<{width: number|undefined, height: number|undefined}>}
 */
async function pngSize(buffer) {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width, height: meta.height };
}

module.exports = {
  filePath, processWatermark,
  watermarkPng, save, remove, hasCustom, invalidate, pngSize,
};
