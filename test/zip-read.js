'use strict';
// A deliberately independent ZIP reader: it walks the central directory itself
// instead of trusting the writer's bookkeeping, so the artefact is verified
// rather than the code that produced it.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

function readZip(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'missing local file header magic');
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd > 0, 'missing end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'missing central directory header');
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, 'bad local header offset');
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    assert.equal(data.length, usize, `${name}: inflated size mismatch`);
    assert.equal(zlib.crc32(data) >>> 0, crc >>> 0, `${name}: CRC mismatch`);
    files.set(name, data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

module.exports = { readZip };
