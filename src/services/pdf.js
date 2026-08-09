const fs = require('fs');
const path = require('path');
const config = require('../config');
const { stripMarkers } = require('./textClean');

const IMG_MARKER = /^\[IMG:\d+\]\s*\n?/gm;

let pdfjs = null;
function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjs;
}

function openDoc(buffer) {
  const { getDocument } = loadPdfjs();
  return getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    standardFontDataUrl: path.join(
      path.dirname(require.resolve('pdfjs-dist/package.json')),
      'standard_fonts',
      path.sep
    ),
    isEvalSupported: false,
  }).promise;
}

async function extractText(buffer) {
  return stripMarkers((await extractDocument(buffer)).text);
}

// Helper: multiply 3x3-affine matrices [a,b,c,d,e,f]
function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

// Bounding box of the unit square under affine matrix m.
function unitSquareAABB(m) {
  const [a, b, c, d, e, f] = m;
  const xs = [e, e + a, e + c, e + a + c];
  const ys = [f, f + b, f + d, f + b + d];
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

// Bounding box of a 2D point list under affine matrix m.
function pointsAABB(pts, m) {
  const [a, b, c, d, e, f] = m;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = a * pts[i] + c * pts[i + 1] + e;
    const y = b * pts[i] + d * pts[i + 1] + f;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Walk one page's operator list, tracking the current transformation matrix
 * (with save/restore stacks) and collecting:
 *   - raster paints (image XObjects drawn over the unit square under the CTM)
 *   - vector path fills/strokes (their point AABB under the CTM)
 *   - joined text lines with the baseline y (user space) of each line's first
 *     item — the same line-join rules as extractText, so marker placement
 *     matches the text the AI later sees.
 * Returns { paints, rows, width, height } in user space (y-up).
 */
async function analyzePage(doc, pageNo) {
  const { OPS } = loadPdfjs();
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const paints = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let lineWidth = 1;
  let pathPts = null;

  const seal = () => {
    if (pathPts && pathPts.length >= 4) {
      const bb = pointsAABB(pathPts, ctm);
      if (bb.w > 0 && bb.h > 0) {
        paints.push({
          kind: 'vector',
          page: pageNo,
          ...bb,
          userMid: bb.y + bb.h / 2,
          strokePad: lineWidth / 2,
        });
      }
    }
    pathPts = null;
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.transform) {
      ctm = mul(ctm, args);
    } else if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.setLineWidth) {
      lineWidth = args[0];
    } else if (fn === OPS.constructPath) {
      // args = [opCodes[], pathNumbers[], minMax[]?] — opCodes are OPS enum
      // values; pathNumbers is the flat coordinate stream for every segment.
      const codes = args[0] || [];
      const nums = args[1] || [];
      let ni = 0;
      let pts = pathPts || [];
      for (const code of codes) {
        if (code === OPS.rectangle) {
          pts.push(nums[ni], nums[ni + 1], nums[ni] + nums[ni + 2], nums[ni + 1] + nums[ni + 3]);
          ni += 4;
        } else if (code === OPS.moveTo || code === OPS.lineTo) {
          pts.push(nums[ni], nums[ni + 1]);
          ni += 2;
        } else if (code === OPS.curveTo) {
          pts.push(nums[ni], nums[ni + 1], nums[ni + 2], nums[ni + 3], nums[ni + 4], nums[ni + 5]);
          ni += 6;
        } else if (code === OPS.curveTo2 || code === OPS.curveTo3) {
          pts.push(nums[ni], nums[ni + 1], nums[ni + 2], nums[ni + 3]);
          ni += 4;
        }
        // closePath (OPS.closePath): no numbers
      }
      pathPts = pts;
    } else if (fn === OPS.rectangle) {
      pathPts = (pathPts || []).concat([args[0], args[1], args[0] + args[2], args[1] + args[3]]);
    } else if (fn === OPS.ellipse) {
      const [x, y, rx, ry] = args;
      pathPts = (pathPts || []).concat([x - rx, y - ry, x + rx, y + ry]);
    } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.stroke || fn === OPS.closeFillStroke || fn === OPS.closeStroke || fn === OPS.endPath) {
      seal();
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const bb = unitSquareAABB(ctm);
      paints.push({
        kind: 'raster',
        page: pageNo,
        ...bb,
        userMid: bb.y + bb.h / 2,
        rasterId: fn === OPS.paintImageXObject ? args[0] : null,
        rasterIsInline: fn === OPS.paintInlineImageXObject,
      });
    }
  }
  seal();

  // Text lines (user space) from getTextContent, joined with the same
  // whitespace rules as extractText so markers land on the same line boxes.
  const content = await page.getTextContent();
  const rows = [];
  let cur = '';
  let curY = null;
  const flush = () => {
    if (cur) rows.push({ y: curY, line: cur });
    cur = '';
    curY = null;
  };
  for (const it of content.items) {
    if (it.hasEOL) flush();
    const s = String(it.str || '');
    if (!cur && it.transform) curY = it.transform[5];
    if (cur && s && !/\s$/.test(cur) && !/^\s/.test(s) && cur.trim() && s.trim()) cur += ' ';
    cur += s;
  }
  flush();
  return { paints, rows, width: vp.width, height: vp.height };
}

// Vector regions cover the fill/stroke AABB plus the stroke half-width.
function vectorBox(p) {
  return { x: p.x - p.strokePad, y: p.y - p.strokePad, w: p.w + 2 * p.strokePad, h: p.h + 2 * p.strokePad };
}

// Region-to-page area ratios used to drop bullets/ornaments and giant spreads.
const PAGE_AREA_MIN = 0.015;
const PAGE_AREA_MAX = 0.20;

/**
 * One pass over the whole document: joined text lines, per-page row geometry
 * (user space), and the filtered image list. Shared by extractDocument and
 * textWithMarkers so marker placement sees exactly the rows the text came from.
 * Returns { textLines, rowsByPage, images } where images entries carry the
 * public canvas-space box plus `userMid` (user-space vertical center) and
 * `kind`/`rasterId` used by the renderers.
 */
async function analyzeDocument(buffer) {
  const doc = await openDoc(buffer);
  const pageData = [];
  for (let p = 1; p <= doc.numPages; p++) {
    pageData.push(await analyzePage(doc, p));
  }
  const textLines = [];
  for (const data of pageData) {
    for (const row of data.rows) textLines.push(row.line);
  }
  const text = textLines.join('\n').replace(/[ \t]+/g, ' ');
  if (!text.trim()) throw new Error('No readable text found in PDF (scanned/image PDFs are not supported yet).');

  // Assemble images page by page with the size filters applied per page, then
  // drop two classes of phantom vectors:
  //  - a 1px frame/outline line drawn around a raster image (identical box,
  //    no content of its own) — the raster carries the figure;
  //  - repeating header/footer ornaments (a logo box at the exact same
  //    position on 2+ pages) — a real question figure never repeats identically.
  const filtered = [];
  for (let p = 0; p < pageData.length; p++) {
    const { paints, width, height } = pageData[p];
    const pageArea = width * height;
    const perPage = paints.filter((q) => {
      const box = q.kind === 'vector' ? vectorBox(q) : q;
      const ratio = (box.w * box.h) / pageArea;
      if (ratio < PAGE_AREA_MIN) return false;
      if (ratio > PAGE_AREA_MAX) {
        return paints.length === 1;
      }
      return true;
    });
    for (const q of perPage) {
      const box = q.kind === 'vector' ? vectorBox(q) : q;
      filtered.push({
        page: p + 1,
        x: box.x,
        y: height - box.y - box.h, // user (y-up) → canvas (y-down)
        w: box.w,
        h: box.h,
        kind: q.kind,
        userBox: { x: box.x, y: box.y, w: box.w, h: box.h },
        userMid: q.userMid,
        rasterId: q.rasterId ?? null,
      });
    }
  }

  const rasters = filtered.filter((q) => q.kind === 'raster');
  const overlap = (a, b) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ix * iy;
  };
  const seenBoxes = new Map(); // `${roundedBox}` → set of pages
  for (const q of filtered) {
    if (q.kind !== 'vector') continue;
    const key = [Math.round(q.x / 2) * 2, Math.round(q.y / 2) * 2, Math.round(q.w / 2) * 2, Math.round(q.h / 2) * 2].join(',');
    if (!seenBoxes.has(key)) seenBoxes.set(key, new Set());
    seenBoxes.get(key).add(q.page);
  }
  const images = [];
  for (let p = 0; p < filtered.length; p++) {
    const q = filtered[p];
    if (q.kind === 'vector') {
      const covered = rasters.some((r) => r.page === q.page && overlap(r, q) >= 0.5 * Math.min(r.w * r.h, q.w * q.h));
      if (covered) continue; // frame/outline around a raster figure
      const key = [Math.round(q.x / 2) * 2, Math.round(q.y / 2) * 2, Math.round(q.w / 2) * 2, Math.round(q.h / 2) * 2].join(',');
      if ((seenBoxes.get(key) || new Set()).size >= 2) continue; // repeating header/footer ornament
      // Text-in-box exclusion: a region containing text rows is a table /
      // labelled graphic, not a figure the students must draw or read.
      const qRows = pageData[q.page - 1].rows;
      if (qRows.some((row) => row.y >= q.userBox.y && row.y <= q.userBox.y + q.userBox.h)) continue;
    }
    images.push(q);
  }

  return { textLines, images, rowsByPage: pageData.map((d) => d.rows) };
}

/**
 * Public extraction: marker-free joined text plus the detected figures
 * [{ page, x, y, w, h, kind, rasterId }] in canvas space (top-left origin).
 */
async function extractDocument(buffer) {
  const { textLines, images } = await analyzeDocument(buffer);
  return {
    text: textLines.join('\n').replace(/[ \t]+/g, ' '),
    images: images.map((q) => {
      const { userBox, userMid, ...pub } = q;
      return pub;
    }),
  };
}

/**
 * Marked text for the import pipeline: an [IMG:n] line is inserted after the
 * nearest text row ABOVE each figure (or at the page start when the figure has
 * no row above it). Returns { text, markers } with markers [{ idx, page }] and
 * n = the figure's index into the extractDocument images array.
 */
async function textWithMarkers(buffer) {
  const { textLines, images, rowsByPage } = await analyzeDocument(buffer);
  const pageStarts = [];
  {
    let n = 0;
    for (const rows of rowsByPage) {
      pageStarts.push(n);
      n += rows.length;
    }
  }
  // Compute every insertion point against the ORIGINAL line array, then splice
  // from the highest position down so no earlier splice shifts a later anchor.
  const inserts = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const pageRows = rowsByPage[img.page - 1] || [];
    let anchor = null;
    for (const row of pageRows) {
      if (row.y > img.userMid && (!anchor || row.y - img.userMid < anchor.y - img.userMid)) anchor = row;
    }
    let at;
    if (anchor) {
      const anchorIndex = textLines.indexOf(anchor.line);
      at = anchorIndex >= 0 ? anchorIndex + 1 : pageStarts[img.page - 1];
    } else {
      at = pageStarts[img.page - 1] || 0;
    }
    inserts.push({ at, marker: `[IMG:${i}]`, idx: i, page: img.page });
  }
  inserts.sort((a, b) => b.at - a.at);
  const lines = textLines.slice();
  const markers = [];
  for (const ins of inserts) {
    lines.splice(ins.at, 0, ins.marker);
    markers.push({ idx: ins.idx, page: ins.page });
  }
  markers.sort((a, b) => a.idx - b.idx);
  return { text: lines.join('\n'), markers };
}

// A canvas 2D context that accepts every call pdfjs's renderer makes but
// draws nothing. pdfjs decodes image XObjects into page.objs only while a
// page render runs; the decode itself is what renderImage needs, so the
// page pixels can be discarded. Drawing into a real @napi-rs/canvas context
// is not an option — pdfjs feeds it glyph path objects that the native
// canvas cannot consume, which aborts the render mid-page.
function noopCanvasContext() {
  const noop = () => {};
  const matrix = () => ({
    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
    invertSelf: () => matrix(), multiply: () => matrix(),
    rotate: () => matrix(), scale: () => matrix(), translate: () => matrix(),
    transformPoint: () => ({ x: 0, y: 0 }), isIdentity: () => true,
  });
  return {
    canvas: { width: 0, height: 0 },
    getTransform: () => matrix(),
    measureText: (t) => ({ width: String(t).length * 4 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({ setTransform: noop }),
    getLineDash: () => [],
    save: noop, restore: noop, transform: noop, translate: noop, scale: noop, rotate: noop,
    setTransform: noop, resetTransform: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop, arc: noop, arcTo: noop,
    rect: noop, ellipse: noop, fill: noop, stroke: noop, fillStroke: noop, clip: noop,
    endPath: noop, setLineDash: noop, drawImage: noop, putImageData: noop, fillRect: noop,
    strokeRect: noop, clearRect: noop, fillText: noop, strokeText: noop, setLineCap: noop,
    setLineJoin: noop, setMiterLimit: noop, setGlobalAlpha: noop, addPath: noop,
  };
}

// Expand pdfjs's decoded pixel buffer (RGBA or RGB) into an RGBA Uint8Clamped
// array; returns null for unsupported kinds (1bpp masks etc).
function rgbaFromPixels(img) {
  const px = img.width * img.height;
  const data = img.data;
  if (img.kind === 3 && data.length >= px * 4) return data.subarray(0, px * 4);
  if (img.kind === 2 && data.length >= px * 3) {
    const rgba = new Uint8ClampedArray(px * 4);
    for (let i = 0, j = 0; i < px * 3; i += 3, j += 4) {
      rgba[j] = data[i];
      rgba[j + 1] = data[i + 1];
      rgba[j + 2] = data[i + 2];
      rgba[j + 3] = 255;
    }
    return rgba;
  }
  return null;
}

/**
 * Render one raster figure to a PNG file: decodes the raw bitmap through a
 * no-op page render, then draws it stretched into the figure's box at 2x.
 * Returns outPath (side effect: writes the file).
 */
async function renderImage(buffer, image, outPath) {
  const doc = await openDoc(buffer);
  const page = await doc.getPage(image.page);
  const vp = page.getViewport({ scale: 1 });
  await page.render({ canvasContext: noopCanvasContext(), viewport: vp }).promise.catch(() => {});
  let img = null;
  if (image.rasterId) {
    try { img = page.objs.get(String(image.rasterId)); } catch { img = null; }
  }
  if (!img || !img.width) {
    for (const [, v] of page.objs) {
      if (v && v.width && v.height) { img = v; break; }
    }
  }
  const { createCanvas } = require('@napi-rs/canvas');
  const cw = Math.max(1, Math.round((image.w || 1) * 2));
  const ch = Math.max(1, Math.round((image.h || 1) * 2));
  const out = createCanvas(cw, ch);
  const octx = out.getContext('2d');
  const rgba = img && img.width ? rgbaFromPixels(img) : null;
  if (rgba) {
    const src = createCanvas(img.width, img.height);
    const sctx = src.getContext('2d');
    const id = sctx.createImageData(img.width, img.height);
    id.data.set(rgba);
    sctx.putImageData(id, 0, 0);
    octx.drawImage(src, 0, 0, cw, ch);
  } else {
    // 1bpp mask / undecodable: a light box is better than a missing figure.
    console.warn('[pdf] image kind unsupported, drawing placeholder:', img && img.kind);
    octx.fillStyle = '#d9d9d9';
    octx.fillRect(0, 0, cw, ch);
  }
  fs.writeFileSync(outPath, out.toBuffer('image/png'));
  return outPath;
}

// Convert pdfjs color args ([r,g,b] 0..1 or gray or cmyk) to a css color
// string usable by @napi-rs/canvas. Returns null when the args are not a
// plain gray/rgb/cmyk array (e.g. pattern or device-n references).
function cssColorFromArgs(args) {
  if (!args || !args.every((v) => typeof v === 'number')) return null;
  const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  if (args.length === 1) {
    const g = toHex(args[0] * 255);
    return `#${g}${g}${g}`;
  }
  if (args.length === 3 && args.every((v) => v >= 0 && v <= 1)) {
    return `#${toHex(args[0] * 255)}${toHex(args[1] * 255)}${toHex(args[2] * 255)}`;
  }
  if (args.length === 4) {
    const [c, m, y, k] = args;
    return `#${toHex(255 * (1 - c) * (1 - k))}${toHex(255 * (1 - m) * (1 - k))}${toHex(255 * (1 - y) * (1 - k))}`;
  }
  return null;
}

/**
 * Replay the page's operator list onto a real @napi-rs/canvas context,
 * skipping the text ops (glyph paths are not consumable by the native
 * canvas). Returns the full-page RGBA canvas mapped through the viewport
 * transform (canvas space, y-down).
 */
async function replayPageOps(page, vp) {
  const { createCanvas } = require('@napi-rs/canvas');
  const { OPS } = loadPdfjs();
  const ops = await page.getOperatorList();
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  const [a, b, c, d, e, f] = vp.transform;
  ctx.transform(a, b, c, d, e, f);

  const colorOp = (args, target) => {
    const col = cssColorFromArgs(args);
    if (col) ctx[target] = col;
  };
  const fillOrStroke = (fn) => {
    if (fn & 1) {
      try { ctx.fill(); } catch { /* clip-only paths */ }
    }
    if (fn & 2) {
      try { ctx.stroke(); } catch { /* clip-only paths */ }
    }
  };

  const srcCache = new Map();
  const drawRaster = (args) => {
    const src = srcCache.get(args[0]);
    if (src) {
      ctx.drawImage(src, 0, 0, 1, 1);
      return;
    }
    let img = null;
    try { img = page.objs.get(String(args[0])); } catch { img = null; }
    if (!img || !img.width) return;
    const rgba = rgbaFromPixels(img);
    if (!rgba) return;
    const s = createCanvas(img.width, img.height);
    const sctx = s.getContext('2d');
    const id = sctx.createImageData(img.width, img.height);
    id.data.set(rgba);
    sctx.putImageData(id, 0, 0);
    const srcCanvas = s;
    srcCache.set(args[0], srcCanvas);
    ctx.drawImage(srcCanvas, 0, 0, 1, 1);
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] || [];
    switch (fn) {
      case OPS.save: ctx.save(); break;
      case OPS.restore: ctx.restore(); break;
      case OPS.transform: ctx.transform(...args); break;
      case OPS.translate: ctx.translate(args[0], args[1]); break;
      case OPS.scale: ctx.scale(args[0], args[1]); break;
      case OPS.rotate: ctx.rotate(args[0]); break;
      case OPS.setTransform: ctx.setTransform(...args); break;
      case OPS.setLineWidth: ctx.lineWidth = args[0]; break;
      case OPS.setLineCap: ctx.lineCap = ['butt', 'round', 'square'][args[0]] || 'butt'; break;
      case OPS.setLineJoin: ctx.lineJoin = ['miter', 'round', 'bevel'][args[0]] || 'miter'; break;
      case OPS.setMiterLimit: ctx.miterLimit = args[0]; break;
      case OPS.setDash: ctx.setLineDash(args[0] || []); ctx.lineDashOffset = args[1] || 0; break;
      case OPS.setGlobalAlpha: ctx.globalAlpha = args[0]; break;
      case OPS.setFillRGBColor:
      case OPS.setFillColorN:
      case OPS.setFillColor:
        colorOp(args, 'fillStyle'); break;
      case OPS.setStrokeRGBColor:
      case OPS.setStrokeColorN:
      case OPS.setStrokeColor:
        colorOp(args, 'strokeStyle'); break;
      case OPS.beginPath: ctx.beginPath(); break;
      case OPS.closePath: ctx.closePath(); break;
      case OPS.moveTo: ctx.moveTo(args[0], args[1]); break;
      case OPS.lineTo: ctx.lineTo(args[0], args[1]); break;
      case OPS.curveTo: ctx.bezierCurveTo(...args); break;
      case OPS.curveTo2: ctx.quadraticCurveTo(args[0], args[1], args[2], args[3]); break;
      case OPS.curveTo3: ctx.quadraticCurveTo(args[0], args[1], args[2], args[3]); break;
      case OPS.rectangle: ctx.rect(args[0], args[1], args[2], args[3]); break;
      case OPS.ellipse: ctx.ellipse(args[0], args[1], args[2], args[3], 0, 0, Math.PI * 2); break;
      case OPS.fill:
      case OPS.eoFill:
        if (args[0] === 2) { try { ctx.fill('evenodd'); } catch { /* opaque layers */ } }
        else { try { ctx.fill(); } catch { /* clip-only */ } }
        break;
      case OPS.stroke:
        try { ctx.stroke(); } catch { /* clip-only */ }
        break;
      case OPS.fillStroke:
        fillOrStroke(3);
        break;
      case OPS.closeFillStroke:
        ctx.closePath();
        fillOrStroke(3);
        break;
      case OPS.closeStroke:
        ctx.closePath();
        try { ctx.stroke(); } catch { /* clip-only */ }
        break;
      case OPS.clip:
        if (args[0] === 2) { try { ctx.clip('evenodd'); } catch { /* skip */ } }
        else { try { ctx.clip(); } catch { /* skip */ } }
        break;
      case OPS.eoClip:
        try { ctx.clip('evenodd'); } catch { /* skip */ }
        break;
      case OPS.endPath:
        ctx.beginPath();
        break;
      case OPS.paintImageXObject:
        drawRaster(args);
        break;
      case OPS.paintInlineImageXObject:
        if (args[0] && args[0].width && args[0].data) {
          const { width, height, data } = args[0];
          const rgba = data.length >= width * height * 4 ? data : rgbaFromPixels({ width, height, kind: 2, data });
          if (rgba) {
            const s = createCanvas(width, height);
            const sctx = s.getContext('2d');
            const id = sctx.createImageData(width, height);
            id.data.set(rgba.subarray ? rgba.subarray(0, width * height * 4) : rgba.slice(0, width * height * 4));
            sctx.putImageData(id, 0, 0);
            ctx.drawImage(s, 0, 0, 1, 1);
          }
        }
        break;
      // showText family and text-state ops are intentionally skipped — glyph
      // paths cannot be replayed on the native canvas.
      default:
        break;
    }
  }
  return canvas;
}

/**
 * Render a vector region (lines, fills, strokes, curves — no text) to a PNG
 * by replaying the page operator list cropped to the figure's box at 2x.
 * Returns outPath (side effect: writes the file).
 */
async function renderVectorRegion(buffer, image, outPath) {
  const { createCanvas } = require('@napi-rs/canvas');
  const doc = await openDoc(buffer);
  const page = await doc.getPage(image.page);
  const vp = page.getViewport({ scale: 1 });
  const full = await replayPageOps(page, vp);
  const pad = 4;
  const cw = Math.max(1, Math.round((image.w + pad * 2) * 2));
  const ch = Math.max(1, Math.round((image.h + pad * 2) * 2));
  const out = createCanvas(cw, ch);
  const octx = out.getContext('2d');
  octx.drawImage(full, image.x - pad, image.y - pad, image.w + pad * 2, image.h + pad * 2, 0, 0, cw, ch);
  fs.writeFileSync(outPath, out.toBuffer('image/png'));
  return outPath;
}

function saveUpload(buffer, originalName) {
  const name = `${Date.now()}-${path.basename(originalName || 'upload.pdf')}`;
  const filePath = path.join(config.uploadsDir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { extractText, extractDocument, textWithMarkers, stripMarkers, renderImage, renderVectorRegion, saveUpload, loadPdfjs, openDoc };