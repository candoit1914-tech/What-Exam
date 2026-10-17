// A .docx is a ZIP of XML parts. Node ships everything needed to build one:
// deflateRawSync for the compressed payload and crc32 for the checksum that
// Word validates on open. About forty lines replaces a ~1 MB dependency for
// what is ~300 lines of XML, and gives first-class control over a picture
// watermark that the `docx` package cannot express without hand-written VML
// anyway.
//
// Deliberately minimal: no zip64, no directory entries, no data descriptors,
// no encryption. Every part of a .docx is small, and a reader that chokes on
// the absence of those features is a reader we want to fail loudly on.
const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_DEFLATE = 8;

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5)
             | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  // MS-DOS epoch is 1980; anything earlier is not representable and does not
  // occur here, but the mask keeps the year in range.
  const day = (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9)
            | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {{name: string, data: Buffer}[]} entries
 * @param {Date} [now] injectable for deterministic tests
 * @returns {Buffer}
 */
function buildZip(entries, now = new Date()) {
  const { time, day } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Fall back to STORE when deflate does not actually help (tiny or
    // incompressible parts), so the artefact never grows for no reason.
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags: no UTF-8 bit, names are ASCII
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk number
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * Read a ZIP and return its entries as { name: Buffer }. The inverse of
 * buildZip, used to pull the XML parts out of a .docx/.xlsx upload.
 *
 * Walks the central directory (not the local headers) because that is the one
 * structure every compliant writer — Word, Excel, LibreOffice — puts at a
 * findable offset: the End Of Central Directory record is the last 22 bytes
 * (plus an optional comment), scanned back from the end. A file this reader
 * cannot parse is one we want to fail loudly on rather than guess at.
 *
 * @param {Buffer} buf
 * @returns {Record<string, Buffer>}
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a ZIP: too short');
  // EOCD is the last record; scan back over its (bounded) comment field.
  let p = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { p = i; break; }
  }
  if (p < 0) throw new Error('not a ZIP: no end-of-central-directory record');

  const count = buf.readUInt16LE(p + 10);
  let q = buf.readUInt32LE(p + 16); // central directory offset
  const out = {};
  for (let n = 0; n < count; n++) {
    if (q + 46 > buf.length || buf.readUInt32LE(q) !== SIG_CENTRAL) {
      throw new Error('corrupt ZIP: bad central directory entry');
    }
    const method = buf.readUInt16LE(q + 10);
    const compressed = buf.readUInt32LE(q + 20);
    const nameLen = buf.readUInt16LE(q + 28);
    const extraLen = buf.readUInt16LE(q + 30);
    const commentLen = buf.readUInt16LE(q + 32);
    const localOffset = buf.readUInt32LE(q + 42);
    const name = buf.toString('utf8', q + 46, q + 46 + nameLen);

    // The local header repeats the name/extra lengths, so its payload start is
    // not at a fixed offset — read them rather than assuming.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`corrupt ZIP: bad local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const payload = buf.subarray(start, start + compressed);

    if (method === 0) out[name] = Buffer.from(payload);
    else if (method === METHOD_DEFLATE) out[name] = zlib.inflateRawSync(payload);
    else throw new Error(`unsupported ZIP compression method ${method} for ${name}`);

    q += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { buildZip, readZip };
