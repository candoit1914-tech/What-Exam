const fs = require('fs');
const path = require('path');
const config = require('../config');
const { stripMarkers } = require('./textClean');

function diag(event, details) {
  if (process.env.PDF_DIAG === '1') console.log('[pdf:diag]', event, details);
}

// PNG byte size does not establish whether a small formula is blank. Inspect
// actual pixels only in diagnostic mode, treating white/transparent as paper.
function diagnoseRender(canvas, page, kind) {
  if (process.env.PDF_DIAG !== '1') return;
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let visible = false;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 0 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 250) {
      visible = true;
      break;
    }
  }
  const details = { page, kind, width: canvas.width, height: canvas.height, blank: !visible };
  diag('render', details);
  if (!visible) console.warn('[pdf] blank render', details);
}

let pdfjs = null;
function loadPdfjs() {
  if (!pdfjs) {
    // pdfjs evaluates its own Path2D handling at module load, so the native
    // canvas Path2D must already be global before (and stay) the single pdfjs
    // instance — otherwise glyph paths can't be replayed on the native canvas.
    if (!globalThis.Path2D) globalThis.Path2D = require('@napi-rs/canvas').Path2D;
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

/**
 * Render a full PDF page to a PNG buffer at the given scale.
 * Used for OCR of scanned/image-only PDFs.
 */
async function renderPageToBuffer(buffer, pageNum, scale = 2) {
  const { createCanvas } = require('@napi-rs/canvas');
  const doc = await openDoc(buffer);
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  // Use replayPageOps to render the page (vector + raster, skips text glyphs)
  const full = await replayPageOps(page, page.getViewport({ scale: 1 }));
  ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/png');
}

/**
 * OCR a single rendered page image buffer using Tesseract.js.
 * Returns the extracted text string.
 */
async function ocrPageBuffer(pageBuffer) {
  const Tesseract = require('tesseract.js');
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: () => {},
  });
  try {
    const { data: { text } } = await worker.recognize(pageBuffer);
    return text || '';
  } finally {
    await worker.terminate();
  }
}

/**
 * For scanned/image-only PDFs: render each page as an image, OCR it,
 * and return text lines + image list (same shape as analyzeDocument).
 * This is the fallback when getTextContent() returns nothing.
 */
async function ocrDocument(buffer) {
  const { createCanvas } = require('@napi-rs/canvas');
  const doc = await openDoc(buffer);
  const Tesseract = require('tesseract.js');
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: () => {},
  });

  const textLines = [];
  const images = [];
  const rowsByPage = [];
  const pageData = [];

  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const vp2 = page.getViewport({ scale: 2 });
      // Render at scale 2 directly for crisp OCR input
      const full = await replayPageOps(page, vp2);
      const canvas = createCanvas(Math.ceil(vp2.width), Math.ceil(vp2.height));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
      const pageBuffer = canvas.toBuffer('image/png');

      // OCR the rendered page
      const { data: { text } } = await worker.recognize(pageBuffer);
      const lines = (text || '').split('\n').filter((l) => l.trim());
      textLines.push(...lines);

      // Create synthetic row entries in scale-1 user space for marker placement
      const pageRows = lines.map((line, i) => ({
        y: vp1.height - ((i + 0.5) * vp1.height / lines.length),
        line,
      }));
      rowsByPage.push(pageRows);

      // Detect images from the operator list (diagrams in scanned PDFs)
      const { OPS } = loadPdfjs();
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
            paints.push({ kind: 'vector', page: p, ...bb, userMid: bb.y + bb.h / 2, strokePad: lineWidth / 2 });
          }
        }
        pathPts = null;
      };

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === OPS.transform) ctm = mul(ctm, args);
        else if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (fn === OPS.setLineWidth) lineWidth = args[0];
        else if (fn === OPS.constructPath) {
          const codes = args[0] || [];
          const nums = args[1] || [];
          let ni = 0;
          let pts = pathPts || [];
          for (const code of codes) {
            if (code === OPS.rectangle) { pts.push(nums[ni], nums[ni + 1], nums[ni] + nums[ni + 2], nums[ni + 1] + nums[ni + 3]); ni += 4; }
            else if (code === OPS.moveTo || code === OPS.lineTo) { pts.push(nums[ni], nums[ni + 1]); ni += 2; }
            else if (code === OPS.curveTo) { pts.push(nums[ni], nums[ni + 1], nums[ni + 2], nums[ni + 3], nums[ni + 4], nums[ni + 5]); ni += 6; }
            else if (code === OPS.curveTo2 || code === OPS.curveTo3) { pts.push(nums[ni], nums[ni + 1], nums[ni + 2], nums[ni + 3]); ni += 4; }
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
          paints.push({ kind: 'raster', page: p, ...bb, userMid: bb.y + bb.h / 2, rasterId: fn === OPS.paintImageXObject ? args[0] : null });
        }
      }
      seal();
      pageData.push({ paints, width: vp1.width, height: vp1.height, rows: pageRows });
    }

    // Apply the same image filtering as analyzeDocument
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
          y: height - box.y - box.h,
          w: box.w,
          h: box.h,
          kind: q.kind,
          userBox: { x: box.x, y: box.y, w: box.w, h: box.h },
          userMid: q.userMid,
          rasterId: q.rasterId ?? null,
        });
      }
    }

    // Drop frame/outline vectors overlapping rasters, repeating headers, text-in-box
    const rasters = filtered.filter((q) => q.kind === 'raster');
    const overlap = (a, b) => {
      const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      return ix * iy;
    };
    const seenBoxes = new Map();
    for (const q of filtered) {
      if (q.kind !== 'vector') continue;
      const key = [Math.round(q.x / 2) * 2, Math.round(q.y / 2) * 2, Math.round(q.w / 2) * 2, Math.round(q.h / 2) * 2].join(',');
      if (!seenBoxes.has(key)) seenBoxes.set(key, new Set());
      seenBoxes.get(key).add(q.page);
    }
    for (const q of filtered) {
      if (q.kind === 'vector') {
        const covered = rasters.some((r) => r.page === q.page && overlap(r, q) >= 0.5 * Math.min(r.w * r.h, q.w * q.h));
        if (covered) continue;
        const key = [Math.round(q.x / 2) * 2, Math.round(q.y / 2) * 2, Math.round(q.w / 2) * 2, Math.round(q.h / 2) * 2].join(',');
        if ((seenBoxes.get(key) || new Set()).size >= 2) continue;
        const qRows = pageData[q.page - 1].rows;
        if (qRows.some((row) => row.y >= q.userBox.y && row.y <= q.userBox.y + q.userBox.h)) continue;
      }
      images.push(q);
    }
  } finally {
    await worker.terminate();
  }

  return { textLines, images, rowsByPage, mathExprs: [] };
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
async function analyzePage(doc, pageNo, mathBase = 0) {
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
  // Math notation (fractions, powers, index stacks) is typeset as STACKED
  // glyphs in a dedicated math font (e.g. g_d0_f3): glyphs at the same
  // x-window whose baselines are ~0.55+ char-heights apart. pdf.js flattens
  // them into plain digits dumped at the END of the page text, so those
  // clusters are detected geometrically, replaced inline with [MATH:n]
  // markers, and later rendered as small region images (renderMathRegion).
  const { exprs, skip } = detectMathExprs(content.items, vp.height);
  const rows = [];
  let cur = '';
  let curY = null;
  // Per-row item geometry (stream order) so a math marker can be spliced at
  // the char offset that matches the cluster's x position.
  let curItems = [];
  const flush = () => {
    if (cur) {
      rows.push({
        y: curY,
        line: cur,
        x0: curItems.length ? Math.min(...curItems.map((i) => i.x)) : 0,
        x1: curItems.length ? Math.max(...curItems.map((i) => i.x + i.w)) : 0,
        __items: curItems,
      });
    }
    cur = '';
    curY = null;
    curItems = [];
  };
  for (const it of content.items) {
    if (it.hasEOL) flush();
    const s = String(it.str || '');
    // Skip glyphs that belong to a detected math cluster - their digits are
    // replaced by a [MATH:n] splice below, never kept as page-tail text.
    if (!s || (it.transform && skip.has(it))) continue;
    if (!cur && it.transform) curY = it.transform[5];
    if (cur && s && !/\s$/.test(cur) && !/^\s/.test(s) && cur.trim() && s.trim()) cur += ' ';
    const cw = it.width != null ? it.width / Math.max(1, s.length) : 6;
    curItems.push({ s, x: it.transform ? it.transform[4] : 0, w: cw });
    if (cur) cur += s; else cur = s;
  }
  flush();
  // Splice each math cluster's marker into its host row at the x position
  // where it belongs, so "Arrange the following: , 0.8," becomes
  // "Arrange the following: [MATH:0], 0.8,". Multiple clusters may share one
  // host row, so every splice is recorded and applied to that row together.
  // Tokens are numbered document-globally (mathBase is the cumulative count
  // from previous pages) so a later question never mixes up two pages' [MATH:0].
  exprs.forEach((ex, n) => {
    const host = findMathHostRow(rows, ex);
    if (!host) {
      console.warn('[pdf] math marker has no host row', { page: pageNo, marker: `[MATH:${mathBase + n}]` });
      return;
    }
    (host.__splices = host.__splices || []).push({ cx: ex.cx, marker: `[MATH:${mathBase + n}]` });
  });
  for (const row of rows) {
    if (!row.__splices || !row.__splices.length) {
      delete row.__items;
      delete row.__splices;
      continue;
    }
    row.__splices.sort((a, b) => a.cx - b.cx);
    spliceMarkersInto(row);
  }
  diag('page extraction', { page: pageNo, rows: rows.length, mathExpressions: exprs.length,
    mathMarkers: rows.reduce((n, row) => n + (row.line.match(/\[MATH:\d+\]/g) || []).length, 0) });
  return { paints, rows, mathExprs: exprs, width: vp.width, height: vp.height };
}

/**
 * Detect stacked-glyph math clusters in a page's text items.
 *
 * Glyphs whose x-windows genuinely intersect are unioned (a fraction's
 * numerator and denominator share the same x column); ordinary letters only
 * abut, so normal words survive untouched. A cluster is treated as math when
 * it holds >=2 glyphs on >=2 distinct baselines separated by at least
 * 0.55 x char-height - the measured signature of a fraction / power / index /
 * matrix stack (normal text shares one baseline). Adjacent stacks of the same
 * font sharing a baseline row (the multi-digit fraction "23/45") merge into
 * one expression.
 *
 * Returns { exprs, skip } where skip is a Set of the source items whose glyphs
 * belong to a cluster (never emitted as plain page text).
 */
function detectMathExprs(items, pageHeight) {
  const chars = [];
  for (const it of items) {
    if (!it.transform) continue;
    const s = String(it.str || '');
    if (!s) continue;
    const cw = it.width != null ? it.width / Math.max(1, s.length) : 6;
    const ch = Math.abs(it.height) || 10;
    for (let k = 0; k < s.length; k++) {
      // Space glyphs never belong to a stack (they inflate a column's baseline
      // set and mask the real numerator/denominator gap).
      if (/\s/.test(s[k])) continue;
      chars.push({
        ch: s[k], font: it.fontName, it,
        x: it.transform[4] + k * cw, y: it.transform[5],
        w: cw, h: ch,
      });
    }
  }
  const byFont = {};
  for (const c of chars) (byFont[c.font] = byFont[c.font] || []).push(c);

  const exprs = [];
  // Two glyphs are "stacked" when their x-windows genuinely intersect (a
  // numerator and denominator share the same x column). Ordinary letters only
  // abut, so overlap-union keeps normal words intact while chaining (running
  // x1) is deliberately avoided — it would fuse whole lines into one giant
  // group and both miss the stack and delete page text.
  const parent = new Map();
  const find = (c) => {
    const p = parent.get(c);
    if (p === c) return c;
    parent.set(c, find(p));
    return parent.get(c);
  };
  const union = (a, b) => parent.set(find(a), find(b));

  for (const list of Object.values(byFont)) {
    const sorted = [...list].sort((a, b) => a.x - b.x || a.y - b.y);
    const active = [];
    for (const c of sorted) {
      parent.set(c, c);
      // Retire glyphs whose x-run can no longer intersect anything later.
      while (active.length && active[0].x + active[0].w < c.x) active.shift();
      for (const d of active) {
        // Stacked members share an x column AND sit vertically near each other.
        // A genuine stack is denser than a line's leading: fraction numerators
        // sit ~0.7x the char-height from their denominator, while ordinary
        // text lines are >>1.0x apart (measured ~11.5pt line vs 8pt stack).
        // Crossing 1.0 makes consecutive text lines union whenever their
        // trailing glyphs happen to align in x (e.g. "Accra." over "largest"),
        // which would delete whole lines as false "math".
        const near = Math.abs(c.y - d.y) < 0.95 * Math.max(c.h, d.h);
        const overlap = Math.min(c.x + c.w, d.x + d.w) - Math.max(c.x, d.x) > 0.1;
        if (near && overlap) union(c, d);
      }
      active.push(c);
    }
  }

  const groups = new Map();
  for (const c of chars) {
    const r = find(c);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  }
  const candidates = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Watermark / masthead script glyphs (the rotated "DOWNLOADED FROM SRONU"
    // ribbon: "SRONU papers.com") also stack with distinct baselines, but the
    // logo is PURE LETTERS and the ".com" suffix is a single large glyph under
    // tiny ones. Real math stacks always carry at least one digit or math
    // symbol, and have >= 2 body-sized glyphs (>= 6.5pt).
    if (g.length < 2) continue;
    if (g.filter((c) => Math.abs(c.h) >= 6.5).length < 2) continue;
    // The logo block ("DOWNLOADED FROM SRONU…papers.com") is PURE LETTERS;
    // real math stacks carry at least one digit or math symbol. Requiring that
    // (rather than merely "not all letters") also stops a stray full stop from
    // turning two aligned text lines into a fake stack.
    if (!g.some((c) => /[0-9+\-×÷=±√∑∏∫≤≥≠∞]/.test(c.ch))) continue;
    const baselines = [...new Set(g.map((c) => c.y))];
    if (baselines.length < 2) continue;
    const ys = [...baselines].sort((a, b) => b - a);
    let maxGap = 0;
    for (let i = 1; i < ys.length; i++) maxGap = Math.max(maxGap, ys[i - 1] - ys[i]);
    const avgH = g.reduce((a, c) => a + c.h, 0) / g.length;
    if (maxGap < 0.55 * avgH) continue;
    // Reject "staircase" columns: 3+ glyphs on >=3 baselines that are all
    // nearly EQUALLY spaced. That is the signature of a text column — option
    // labels ("A. 4x^2" over "B. 2x^2" over "C. 4x"...) or a table of numbers
    // — at one x position, NOT a math expression. Genuine stacks have an
    // irregular baseline spread (a tight numerator/denominator pair).
    if (ys.length >= 3) {
      const g0 = ys[0] - ys[1];
      let even = true;
      for (let i = 2; i < ys.length; i++) {
        if (Math.abs(ys[i - 1] - ys[i] - g0) > 0.6) { even = false; break; }
      }
      if (even) continue;
    }
    // A stack's glyphs are one type size: a fraction's numerator and
    // denominator (and matrix members) match. Consecutive text lines that
    // align at the same left margin ("2026 BECE" title over "1. Use the
    // circle...") stack a 16pt line over an 11pt line — sizes that never
    // appear inside one expression.
    {
      let hMin = Infinity, hMax = 0;
      for (const c of g) { hMin = Math.min(hMin, Math.abs(c.h)); hMax = Math.max(hMax, Math.abs(c.h)); }
      if (hMax / hMin > 1.4) continue;
    }
    candidates.push(sealStack(g, pageHeight));
  }
  // Merge adjacent stacks of the same font that share a baseline row — the
  // multi-digit fraction "23/45" is two side-by-side columns (2/4 and 3/5)
  // that should render as ONE expression.
  candidates.sort((a, b) => a.x0 - b.x0);
  const merged = [];
  for (const c of candidates) {
    const prev = merged[merged.length - 1];
    const charW = (c.avgH); // approximate column advance
    if (
      prev && prev.font === c.font &&
      c.x0 - prev.x1 < 0.9 * charW &&
      intersectHas(prev.ys, c.ys)
    ) {
      prev.chars.push(...c.chars);
      computedStackExtent(prev);
    } else {
      merged.push(c);
    }
  }
  const skip = new Set();
  for (const m of merged) {
    const box = { x: m.x0 - 2, y: pageHeight - m.yBot - 2, w: m.x1 - m.x0 + 4, h: m.yBot - m.yTop + 4 };
    exprs.push({
      box,
      cx: (m.x0 + m.x1) / 2,
      cy: m.yTop + (m.yBot - m.yTop) / 2,
      skip: m.items,
    });
    for (const it of m.items) skip.add(it);
  }
  return { exprs, skip };
}

function sealStack(g, pageHeight) {
  let x0 = Infinity, x1 = -Infinity, yTop = Infinity, yBot = -Infinity;
  const items = new Set();
  const ys = new Set();
  let hSum = 0;
  for (const c of g) {
    x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x + c.w);
    yTop = Math.min(yTop, c.y); yBot = Math.max(yBot, c.y + c.h);
    ys.add(c.y);
    items.add(c.it);
    hSum += c.h;
  }
  return { chars: g, font: g[0].font, x0, x1, yTop, yBot, ys: [...ys], avgH: hSum / g.length, items };
}

function computedStackExtent(s) {
  let x0 = Infinity, x1 = -Infinity, yTop = Infinity, yBot = -Infinity;
  const items = new Set();
  for (const c of s.chars) {
    x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x + c.w);
    yTop = Math.min(yTop, c.y); yBot = Math.max(yBot, c.y + c.h);
    s.ys.push(c.y);
    items.add(c.it);
  }
  s.ys = [...new Set(s.ys)];
  s.x0 = x0; s.x1 = x1; s.yTop = yTop; s.yBot = yBot;
  s.items = items;
}

function intersectHas(a, b) {
  const set = new Set(b);
  return a.some((v) => set.has(v));
}

/** The row a math expression belongs to. A stacked expression straddles its
 * own text line's baseline (numerator above, denominator below), so the host
 * is simply the row whose baseline is closest; x-overlap is only a tiebreaker
 * when two rows are equally near (dense leading). Falls back to the vertically
 * nearest row for standalone "Simplify:" -> expression layouts. */
function findMathHostRow(rows, ex) {
  let best = null;
  let bestDy = Infinity;
  for (const r of rows) {
    const dy = Math.abs(r.y - ex.cy);
    if (dy < bestDy - 0.75) { bestDy = dy; best = r; }
    else if (dy <= bestDy + 0.75 && best && ex.cx >= r.x0 && ex.cx <= r.x1) { bestDy = dy; best = r; }
  }
  return best || rows.reduce((a, b) => (Math.abs(b.y - ex.cy) < Math.abs(a.y - ex.cy) ? b : a), rows[0]) || null;
}

/** Insert every marker into its host row at the char offset matching the
 * cluster's x. The row string was built from __items in stream order, so the
 * line is rebuilt walking __items in order, inserting each marker the first
 * time an item sits physically right of its cluster x. */
function spliceMarkersInto(row) {
  let out = '';
  let si = 0;
  for (const it of row.__items) {
    while (si < row.__splices.length && it.x > row.__splices[si].cx) {
      out += row.__splices[si++].marker;
    }
    const s = it.s;
    if (out && s && !/\s$/.test(out) && !/^\s/.test(s) && out.trim() && s.trim()) out += ' ';
    out += s;
  }
  while (si < row.__splices.length) out += row.__splices[si++].marker;
  row.line = out;
  delete row.__items;
  delete row.__splices;
}

// Vector regions cover the fill/stroke AABB plus the stroke half-width.
function vectorBox(p) {
  return { x: p.x - p.strokePad, y: p.y - p.strokePad, w: p.w + 2 * p.strokePad, h: p.h + 2 * p.strokePad };
}

// Region-to-page area ratios used to drop bullets/ornaments and giant spreads.
const PAGE_AREA_MIN = 0.015;
const PAGE_AREA_MAX = 0.20;
// Math expressions are short, wide images (e.g. a typeset equation under
// "Simplify:") far smaller than diagrams. Keep wide low-profile rasters above a
// lower floor, provided they are not hairlines (a thin line has a tiny side).
const RASTER_WIDE_MIN = 0.004;
const RASTER_WIDE_ASPECT = 2.5;
// Real text pages carry roughly 1,500-3,000 characters and 200+ words. A scan
// that slipped a text layer in (page number, running header, watermark, scan
// stamp) yields a few dozen characters and far fewer words.
//
// Three independent gates must ALL look like a dead text layer before OCR is
// used, because no single signal can tell them apart:
//
//   1. Character density - separates a real paper from junk. Checked first, so
//      a real document never reaches the cheaper checks.
//   2. Word density - rescues a genuinely short real page, and catches junk
//      made of bare page numbers.
//   3. Word variety - catches a dense repeated running header, which carries
//      enough characters and enough words to pass gates 1 and 2, but is the
//      same three words on every page. Real text is varied; a header is not.
//
// Gates 1 and 2 alone are not enough. A real page can be short: a one-page
// question sheet, a math-heavy page that is mostly symbols, a stem with an
// image and four options. OCR-ing those replaces real text with OCR
// approximations, destroying math markers and breaking sentence merging.
const OCR_FALLBACK_CHARS_PER_PAGE = 200;
const OCR_FALLBACK_WORDS_PER_PAGE = 4;
const OCR_FALLBACK_MIN_WORDS_PER_PAGE = 1;
const OCR_FALLBACK_DISTINCT_RATIO = 0.5;

/**
 * Whether a document's extracted text is too sparse to be a real text layer,
 * meaning the pages are images and must go through OCR.
 *
 * The OCR fallback used to trigger only when the text was completely empty, so
 * a scan that produced a stray page number or header skipped OCR entirely,
 * yielded zero question blocks, and failed with an error blaming the user's
 * document for having no questions in it.
 *
 * @param {string} text
 * @param {number} pageCount
 * @returns {boolean}
 */
function needsOcrFallback(text, pageCount) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  const pages = Number(pageCount) > 0 ? Number(pageCount) : 1;

  if (trimmed.length >= OCR_FALLBACK_CHARS_PER_PAGE * pages) return false;

  // Word-like tokens: 2+ letters, so bare page numbers and "2026" do not count.
  const words = trimmed.match(/[A-Za-z]{2,}/g) || [];
  if (words.length >= OCR_FALLBACK_WORDS_PER_PAGE * pages) return false;

  // Too few words for variety to mean anything. A single word like "Biology" is
  // trivially "all distinct", so this gate must not be allowed to rescue a
  // document that has one word spread across a whole scanned paper.
  if (words.length < OCR_FALLBACK_MIN_WORDS_PER_PAGE * pages) return true;

  // Enough words to judge them by: varied words are a real text layer, the
  // same few words repeated on every page are a running header.
  const distinct = new Set(words.map((w) => w.toLowerCase())).size;
  if (distinct >= OCR_FALLBACK_DISTINCT_RATIO * words.length) return false;

  return true;
}

const RASTER_WIDE_MIN_SIDE = 20;
// Vector boxes taller than this that contain text are treated as tables or
// labelled graphics; shorter wide ones are kept as math expressions.
const VECTOR_TEXT_BOX_MAX_H = 60;

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
  let mathBase = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const data = await analyzePage(doc, p, mathBase);
    pageData.push(data);
    mathBase += data.mathExprs.length;
  }
  const textLines = [];
  for (const data of pageData) {
    for (const row of data.rows) textLines.push(row.line);
  }
  // Join lines intelligently: merge a line with the previous one when the
  // previous line does not end with sentence-ending punctuation and the
  // current line does not start a new sentence (lowercase or continuation).
  // This prevents mid-sentence breaks that produce truncated questions on WhatsApp.
  const merged = [];
  for (const line of textLines) {
    const trimmed = line.trim();
    if (!trimmed) { merged.push(''); continue; }
    const prev = merged.length > 0 ? merged[merged.length - 1] : '';
    const prevEndsSentence = /[.!?;:]\s*$/.test(prev);
    const curStartsNewSentence = /^[A-Z(]/.test(trimmed) && !prevEndsSentence;
    const looksLikeOption = /^\(?[A-Da-d]\)?[.\-:\])]/.test(trimmed);
    const looksLikeNumber = /^\d{1,3}\s*[.)]/.test(trimmed);
    if (prev && !prevEndsSentence && !curStartsNewSentence && !looksLikeOption && !looksLikeNumber && prev.length > 0) {
      merged[merged.length - 1] = prev + ' ' + trimmed;
    } else {
      merged.push(trimmed);
    }
  }
  const text = merged.join('\n').replace(/[ \t]+/g, ' ');
  if (needsOcrFallback(text, doc.numPages)) {
    // No usable text layer - this is a scanned/image-only PDF, or one whose
    // only "text" was a stray header/page number. Fall back to OCR: render
    // each page as an image and run Tesseract.
    console.log(
      `[pdf] Text layer absent or too sparse (${text.trim().length} chars over ${doc.numPages} pages), falling back to OCR...`
    );
    const ocrResult = await ocrDocument(buffer);
    ocrResult._ocr = true;
    // Sentence-join the raw OCR lines (same algorithm as below)
    const merged = [];
    for (const line of ocrResult.textLines) {
      const trimmed = line.trim();
      if (!trimmed) { merged.push(''); continue; }
      const prev = merged.length > 0 ? merged[merged.length - 1] : '';
      const prevEndsSentence = /[.!?;:]\s*$/.test(prev);
      const curStartsNewSentence = /^[A-Z(]/.test(trimmed) && !prevEndsSentence;
      const looksLikeOption = /^\(?[A-Da-d]\)?[.\-:\])]/.test(trimmed);
      const looksLikeNumber = /^\d{1,3}\s*[.)]/.test(trimmed);
      if (prev && !prevEndsSentence && !curStartsNewSentence && !looksLikeOption && !looksLikeNumber && prev.length > 0) {
        merged[merged.length - 1] = prev + ' ' + trimmed;
      } else {
        merged.push(trimmed);
      }
    }
    ocrResult.textLines = merged;
    return ocrResult;
  }

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
      const wideProfile = box.h > 0 && box.w / box.h >= RASTER_WIDE_ASPECT && Math.min(box.w, box.h) >= RASTER_WIDE_MIN_SIDE;
      const minRatio = q.kind === 'raster' && wideProfile ? RASTER_WIDE_MIN : PAGE_AREA_MIN;
      if (ratio < minRatio) return false;
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
      // Text-in-box exclusion: a tall region containing text rows is a table /
      // labelled graphic, not a figure. Short, wide boxes carrying just a line
      // of text are math expressions/equations — keep those so "Simplify:"-style
      // questions still carry their expression.
      const qRows = pageData[q.page - 1].rows;
      const hasTextInside = qRows.some((row) => row.y >= q.userBox.y && row.y <= q.userBox.y + q.userBox.h);
      if (hasTextInside && q.userBox.h > VECTOR_TEXT_BOX_MAX_H) continue;
    }
    // Page-header/masthead images (a banner or logo at the top of a page with
    // no text row above it) reference no question. Dropping them prevents a
    // meaningless image from being attached to the first question and shown
    // above it in WhatsApp.
    const pageRows = pageData[q.page - 1].rows;
    if (q.userBox && !pageRows.some((row) => row.y > q.userBox.y + q.userBox.h)) continue;
    images.push(q);
  }

  // mathExprs[exprIndex] === the expression behind token [MATH:exprIndex]:
  // tokens are numbered document-globally, so the flat array position IS the
  // index used by ai.js markerIndices and pdfImport's renderer.
  return { textLines: merged, images, rowsByPage: pageData.map((d) => d.rows), mathExprs: pageData.flatMap((d, p) => d.mathExprs.map((ex) => ({ page: p + 1, ...ex.box }))) };
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
  const { textLines, images, rowsByPage, mathExprs, _ocr } = await analyzeDocument(buffer);
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
  // Apply the same sentence-joining logic as analyzeDocument so markers
  // land on complete sentences, not mid-sentence fragments.
  const joinedLines = [];
  for (const line of textLines) {
    const trimmed = line.trim();
    if (!trimmed) { joinedLines.push(''); continue; }
    const prev = joinedLines.length > 0 ? joinedLines[joinedLines.length - 1] : '';
    const prevEndsSentence = /[.!?;:]\s*$/.test(prev);
    const curStartsNewSentence = /^[A-Z(]/.test(trimmed) && !prevEndsSentence;
    const looksLikeOption = /^\(?[A-Da-d]\)?[.\-:\])]/.test(trimmed);
    const looksLikeNumber = /^\d{1,3}\s*[.)]/.test(trimmed);
    if (prev && !prevEndsSentence && !curStartsNewSentence && !looksLikeOption && !looksLikeNumber && prev.length > 0) {
      joinedLines[joinedLines.length - 1] = prev + ' ' + trimmed;
    } else {
      joinedLines.push(trimmed);
    }
  }

  const inserts = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const pageRows = rowsByPage[img.page - 1] || [];
    // Anchor to the text row directly above the image's TOP edge (not its
    // midpoint); options/legends below the figure then never capture the
    // marker, and a "Simplify:"-style stem right above an expression does.
    const imgTop = img.userBox ? img.userBox.y + img.userBox.h : img.userMid;
    let anchor = null;
    for (const row of pageRows) {
      if (row.y > imgTop && (!anchor || row.y - imgTop < anchor.y - imgTop)) anchor = row;
    }
    let at;
    if (anchor) {
      // Find the merged line that contains the anchor's original text
      const anchorText = anchor.line.trim();
      let anchorIndex = -1;
      for (let j = 0; j < joinedLines.length; j++) {
        if (joinedLines[j].includes(anchorText) || anchorText.includes(joinedLines[j])) {
          anchorIndex = j;
          break;
        }
      }
      at = anchorIndex >= 0 ? anchorIndex + 1 : pageStarts[img.page - 1];
    } else {
      at = pageStarts[img.page - 1] || 0;
    }
    inserts.push({ at, marker: `[IMG:${i}]`, idx: i, page: img.page });
  }
  inserts.sort((a, b) => b.at - a.at);
  const lines = joinedLines.slice();
  const markers = [];
  for (const ins of inserts) {
    lines.splice(ins.at, 0, ins.marker);
    markers.push({ idx: ins.idx, page: ins.page });
  }
  markers.sort((a, b) => a.idx - b.idx);
  const text = lines.join('\n');
  const found = new Set(Array.from(text.matchAll(/\[MATH:(\d+)\]/g), (m) => Number(m[1])));
  const missing = (mathExprs || []).map((ex, idx) => ({ page: ex.page, marker: `[MATH:${idx}]`, idx }))
    .filter((entry) => !found.has(entry.idx));
  const diagnostics = { pages: rowsByPage.length, imageMarkers: markers.length,
    mathExpressions: (mathExprs || []).length, mathMarkers: found.size, missingMathMarkers: missing.length };
  if (missing.length) console.warn('[pdf] math markers missing from extracted text', { count: missing.length });
  diag('extraction summary', diagnostics);
  return { text, markers, images, mathExprs, _ocr: !!_ocr, diagnostics };
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
 * Falls back to replayPageOps (full page render + crop) for scanned PDFs
 * where the raster isn't in page.objs.
 * Returns outPath (side effect: writes the file).
 */
async function renderImage(buffer, image, outPath) {
  const { createCanvas } = require('@napi-rs/canvas');
  const doc = await openDoc(buffer);
  const page = await doc.getPage(image.page);
  const vp = page.getViewport({ scale: 1 });
  await page.render({ canvasContext: noopCanvasContext(), viewport: vp }).promise.catch(() => {});
  let img = null;
  if (image.rasterId) {
    try { img = page.objs.get(String(image.rasterId)); } catch { img = null; }
  }
  // An unrelated decoded bitmap (for example a logo) is never a valid
  // substitute for the requested raster. Use the page crop below instead.
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
    // Raster not in page.objs (scanned PDF) — fall back to replayPageOps
    // which renders the full page vector+raster ops, then crop to the figure box.
    try {
      const full = await replayPageOps(page, vp);
      const pad = 4;
      octx.drawImage(full, image.x - pad, image.y - pad, image.w + pad * 2, image.h + pad * 2, 0, 0, cw, ch);
    } catch (err) {
      console.warn('[pdf] image render failed', { page: image.page });
      throw err;
    }
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

/**
 * Render a math expression region (a stacked-foundry cluster that was replaced
 * inline by a [MATH:n] marker) to a PNG. Unlike renderVectorRegion, the glyphs
 * MUST be drawn too — pdfjs emits them as Path2D objects, which the native
 * canvas accepts once `globalThis.Path2D` shadows the (absent) global. Renders
 * the full page through pdfjs at `scale`, then crops the expression box and
 * writes the PNG. Pass an optional `pageCache` Map (page number -> rendered
 * canvas) to render each page at most once per import job.
 * Returns outPath (side effect: writes the file).
 */
async function renderMathRegion(buffer, expr, outPath, scale = 4, pageCache) {
  const { createCanvas } = require('@napi-rs/canvas');
  if (!globalThis.Path2D) globalThis.Path2D = require('@napi-rs/canvas').Path2D;
  const doc = await openDoc(buffer);
  const page = await doc.getPage(expr.page);
  const vp = page.getViewport({ scale });
  const cw = Math.max(1, Math.round(expr.w * scale));
  const ch = Math.max(1, Math.round(expr.h * scale));
  const out = createCanvas(cw, ch);
  const octx = out.getContext('2d');
  try {
    let canvas = pageCache && pageCache.get(expr.page);
    if (!canvas) {
      canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (pageCache) pageCache.set(expr.page, canvas);
    }
    octx.drawImage(canvas, expr.x * scale, expr.y * scale, cw, ch, 0, 0, cw, ch);
  } catch (err) {
    console.warn('[pdf] math region render failed', { page: expr.page });
    throw err;
  }
  diagnoseRender(out, expr.page, 'math');
  fs.writeFileSync(outPath, out.toBuffer('image/png'));
  return outPath;
}

function saveUpload(buffer, originalName) {
  const name = `${Date.now()}-${path.basename(originalName || 'upload.pdf')}`;
  const filePath = path.join(config.uploadsDir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { extractText, extractDocument, textWithMarkers, stripMarkers, renderImage, renderVectorRegion, renderMathRegion, renderPageToBuffer, saveUpload, loadPdfjs, openDoc, needsOcrFallback };
