'use strict';
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildZip } = require('../src/services/zip');
const { readZip } = require('./zip-read');

test('buildZip stores each entry and round-trips through an independent reader', () => {
  const xml = '<?xml version="1.0"?><w:p><w:r><w:t>Héllo — Ünicode</w:t></w:r></w:p>';
  const bin = Buffer.from([0, 1, 2, 253, 254, 255, 0, 128]);

  const out = buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(xml, 'utf8') },
    { name: 'word/media/watermark.png', data: bin },
  ]);
  const files = readZip(out);
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', 'word/media/watermark.png']);
  assert.equal(files.get('[Content_Types].xml').toString('utf8'), xml);
  assert.deepEqual(files.get('word/media/watermark.png'), bin);
});

test('buildZip handles an empty payload and a large-ish entry', () => {
  const big = Buffer.alloc(300 * 1024, 0x41);
  const files = readZip(buildZip([
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'big.txt', data: big },
  ]));
  assert.equal(files.get('empty.txt').length, 0);
  assert.deepEqual(files.get('big.txt'), big);
});
