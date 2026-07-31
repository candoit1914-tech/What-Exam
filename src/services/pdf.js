const fs = require('fs');
const path = require('path');
const config = require('../config');

let getDocument = null;

async function extractText(buffer) {
  if (!getDocument) {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
    getDocument = pdfjs.getDocument;
  }
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    standardFontDataUrl: path.join(
      path.dirname(require.resolve('pdfjs-dist/package.json')),
      'standard_fonts',
      path.sep
    ),
    isEvalSupported: false,
  }).promise;
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    for (const item of content.items) {
      if (item.hasEOL) {
        parts.push(line);
        line = '';
      }
      line += item.str;
    }
    if (line) parts.push(line);
  }
  const text = parts.join('\n');
  if (!text.trim()) throw new Error('No readable text found in PDF (scanned/image PDFs are not supported yet).');
  return text;
}

function saveUpload(buffer, originalName) {
  const name = `${Date.now()}-${path.basename(originalName || 'upload.pdf')}`;
  const filePath = path.join(config.uploadsDir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { extractText, saveUpload };
