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

async function readSource() {
  try {
    return await fsp.readFile(filePath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return await fsp.readFile(defaultSource());
  }
}

function filePath() {
  return path.join(config.uploadsDir, FILE);
}

// A single cached promise, the pattern src/services/certificate.js:10 already
// uses. Failures are NOT cached: a transient decode error must not poison the
// process until restart.
let cached = null;

async function watermarkPng() {
  if (!cached) {
    cached = (async () => processWatermark(await readSource()))().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/**
 * Store an upload, untouched, as the app's watermark source.
 *
 * The bytes are validated by DECODING them and then written verbatim; the
 * pipeline runs once, in watermarkPng(), on read. Processing here as well is
 * what made the logo come out double-washed: `blur(2.5)` is not idempotent and
 * neither is `linear(1, 96)`, so the default icon.svg measured 46,648 bytes
 * through one pass and 23,455 bytes through two - visibly fainter than intended.
 *
 * The decode is also the security boundary. sharp refuses bytes that are not
 * really an image, so nothing undecodable is ever written, and because the
 * stored bytes are RAW this function deliberately returns nothing: handing the
 * raw buffer back to a caller would put un-rasterised, user-supplied markup one
 * careless `res.send()` away from a browser. The stored filename is
 * server-chosen, never the client's.
 *
 * @param {Buffer} buffer the uploaded image, in any format sharp can decode
 * @returns {Promise<void>}
 */
async function save(buffer) {
  await pngSize(buffer);
  await fsp.mkdir(config.uploadsDir, { recursive: true });
  // Write-then-rename so a reader never sees a half-written file.
  const tmp = `${filePath()}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, filePath());
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
 * recognise, and it is the only decode save() performs.
 *
 * @param {Buffer} buffer a PNG
 * @returns {Promise<{width: number|undefined, height: number|undefined}>}
 */
async function pngSize(buffer) {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width, height: meta.height };
}

module.exports = {
  SIZE, FILE, filePath, defaultSource, processWatermark,
  watermarkPng, save, remove, hasCustom, invalidate, pngSize,
};
