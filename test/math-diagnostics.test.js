'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Load the production service with explicit dependencies: no .env, production
// database, uploads directory, AI endpoint, or network is touched by this suite.
function loadService(name, overrides = {}, enabled = false) {
  const filename = path.resolve(__dirname, '../src/services', name + '.js');
  const nativeRequire = createRequire(filename);
  const logs = { log: [], warn: [], error: [] };
  const scopedRequire = (id) => Object.hasOwn(overrides, id) ? overrides[id] :
    id === '../config' ? { uploadsDir: '/isolated-uploads' } : nativeRequire(id);
  scopedRequire.resolve = nativeRequire.resolve;
  const sandbox = { module: { exports: {} }, require: scopedRequire,
    process: { env: { PDF_DIAG: enabled ? '1' : '0' } },
    console: Object.fromEntries(Object.keys(logs).map((level) => [level, (...args) => logs[level].push(args)])),
    Buffer, Uint8Array, Uint8ClampedArray };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return { service: sandbox.module.exports, logs };
}

function renderer({ fail = false, enabled = false } = {}) {
  const writes = [];
  let pixelReads = 0;
  const canvasModule = require('@napi-rs/canvas');
  const page = {
    getViewport: ({ scale }) => ({ width: 100 * scale, height: 100 * scale, transform: [scale, 0, 0, scale, 0, 0] }),
    render: () => ({ promise: fail ? Promise.reject(new Error('render broke')) : Promise.resolve() }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    objs: new Map([['unrelated-logo', { width: 1, height: 1, kind: 3, data: new Uint8Array([255, 0, 0, 255]) }]]),
  };
  const loaded = loadService('pdf', {
    fs: { writeFileSync: (file, bytes) => writes.push({ file, bytes }) },
    '@napi-rs/canvas': { ...canvasModule, createCanvas: (...args) => {
      const canvas = canvasModule.createCanvas(...args);
      const ctx = canvas.getContext('2d');
      const read = ctx.getImageData.bind(ctx);
      ctx.getImageData = (...coords) => { pixelReads++; return read(...coords); };
      return canvas;
    } },
    'pdfjs-dist/legacy/build/pdf.mjs': { OPS: {}, getDocument: () => ({ promise: Promise.resolve({ getPage: async () => page }) }) },
  }, enabled);
  return { ...loaded, writes, pixelReads: () => pixelReads };
}

test('failed math render rejects and never writes a successful white placeholder', async () => {
  const { service, writes, logs } = renderer({ fail: true });
  await assert.rejects(service.renderMathRegion(Buffer.alloc(0), { page: 3, x: 1, y: 1, w: 10, h: 10 }, 'math.png'), /render broke/);
  assert.equal(writes.length, 0);
  assert.equal(logs.warn.length, 1);
  assert.equal(logs.warn[0][1].page, 3);
});

test('render detail and real blank-pixel check are gated by PDF_DIAG', async () => {
  for (const enabled of [false, true]) {
    const r = renderer({ enabled });
    await r.service.renderMathRegion(Buffer.alloc(0), { page: 2, x: 1, y: 1, w: 10, h: 10 }, 'math.png');
    assert.equal(r.pixelReads(), enabled ? 1 : 0);
    assert.equal(r.logs.log.length, enabled ? 1 : 0);
    assert.equal(r.logs.warn.length, enabled ? 1 : 0);
    if (enabled) assert.equal(r.logs.warn[0][1].blank, true);
  }
});

test('missing raster never attaches an unrelated decoded logo', async () => {
  const r = renderer();
  await r.service.renderImage(Buffer.alloc(0), { page: 1, rasterId: 'missing', x: 10, y: 10, w: 10, h: 10 }, 'image.png');
  const { loadImage, createCanvas } = require('@napi-rs/canvas');
  const image = await loadImage(r.writes[0].bytes);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  assert.equal(ctx.getImageData(0, 0, 1, 1).data[3], 0, 'empty page crop must not become the red logo');
});

test('math attachment errors are counted, warn, and retain contiguous successful positions', async () => {
  const stored = [];
  let calls = 0;
  const { service, logs } = loadService('pdfImport', {
    '../db': { prepare: () => ({ run: (...args) => {
      if (++calls === 1) throw new Error('storage unavailable');
      stored.push(args);
    } }) },
    './pdf': { renderMathRegion: async (_, expr) => { if (expr.page === 2) throw new Error('render failed'); } },
    './ai': {}, './marking': {},
  });
  const result = await service.storeMathImages({ markerIndices: [0, 1, 2, 3, 99, 3] }, 42,
    [{ page: 1 }, { page: 2 }, { page: 3 }, { page: 4 }], new Map(), Buffer.alloc(0), 5, 1);
  assert.equal(result.requested, 5);
  assert.equal(result.failed, 3);
  assert.equal(result.attached, 2);
  assert.deepEqual(stored.map((row) => row[1]), [0, 1]);
  assert.equal(logs.warn.length, 1);
  assert.equal(logs.log.length, 0);
});

test('real PDF extraction reports document and marker counts without logging question text', async () => {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument();
  const chunks = [];
  const done = new Promise((resolve, reject) => { doc.on('data', (x) => chunks.push(x)); doc.on('end', resolve); doc.on('error', reject); });
  doc.text('1. Confidential sample question.');
  doc.addPage().text('2. Another sample question.');
  doc.end();
  await done;
  const { service, logs } = loadService('pdf', {}, true);
  const result = await service.textWithMarkers(Buffer.concat(chunks));
  assert.equal(result.diagnostics.pages, 2);
  assert.equal(result.diagnostics.mathExpressions, 0);
  assert.equal(result.diagnostics.missingMathMarkers, 0);
  assert.equal(logs.log.filter((x) => x[1] === 'page extraction').length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /Confidential|sample question/);
});
