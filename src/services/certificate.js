const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const LOGO_SVG = fs.readFileSync(path.resolve(__dirname, '../public/icon.svg'), 'utf8');
const LOGO_INNER = LOGO_SVG.replace(/<\?xml[^>]*\?>/, '').replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const WIDTH = 1600;
const HEIGHT = 1131;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d = new Date()) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dt = d instanceof Date ? d : new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')} ${m[dt.getMonth()] || '???'} ${dt.getFullYear()}`;
}

function buildCertificateSvg({
  studentName,
  examTitle,
  subject,
  date = new Date(),
  score,
  totalMarks,
  percentage,
  passed,
}) {
  const name = esc(studentName || 'Student');
  const title = esc(examTitle || 'Examination');
  const subj = subject ? esc(subject) : '';
  const dt = formatDate(date);
  const pct = typeof percentage === 'number' ? `${Math.round(percentage * 10) / 10}%` : '—';
  const result = passed ? 'PASS' : 'FAIL';
  const resultColor = passed ? '#15803d' : '#b91c1c';
  const marks = totalMarks != null ? `${score}/${totalMarks}` : '—';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#FFFDF6"/>
  <rect x="40" y="40" width="${WIDTH - 80}" height="${HEIGHT - 80}" rx="26" fill="none" stroke="#C9A227" stroke-width="6"/>
  <rect x="62" y="62" width="${WIDTH - 124}" height="${HEIGHT - 124}" rx="16" fill="none" stroke="#16AB52" stroke-width="2"/>
  <rect x="82" y="82" width="${WIDTH - 164}" height="${HEIGHT - 164}" rx="10" fill="none" stroke="#C9A227" stroke-width="1"/>

  <g transform="translate(768 96) scale(1.1)">${LOGO_INNER}</g>
  <text x="800" y="218" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" letter-spacing="12" fill="#066F36" font-weight="bold">WHAT EXAM</text>

  <text x="800" y="300" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="66" fill="#1f2937">Certificate of Participation</text>
  <line x1="470" y1="330" x2="1130" y2="330" stroke="#C9A227" stroke-width="2"/>

  <text x="800" y="408" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" fill="#6b7280">This certifies that</text>
  <text x="800" y="520" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="76" font-style="italic" fill="#111827">${name}</text>
  <line x1="540" y1="548" x2="1060" y2="548" stroke="#16AB52" stroke-width="2"/>
  <text x="800" y="608" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" fill="#6b7280">has successfully participated in the examination</text>
  <text x="800" y="668" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="40" font-weight="bold" fill="#066F36">${title}${subj ? ` — ${subj}` : ''}</text>

  <g font-family="Arial, sans-serif" font-size="24" fill="#374151" text-anchor="middle">
    <text x="800" y="780" font-weight="bold" fill="#111827">Score: <tspan fill="#066F36">${marks}</tspan></text>
    <text x="800" y="826">Percentage: <tspan font-weight="bold">${pct}</tspan></text>
    <text x="800" y="872">Result: <tspan font-weight="bold" fill="${resultColor}">${result}</tspan></text>
    <text x="800" y="918">Date: ${dt}</text>
  </g>

  <g font-family="Georgia, 'Times New Roman', serif">
    <line x1="1050" y1="1016" x2="1410" y2="1016" stroke="#111827" stroke-width="1.5"/>
    <text x="1230" y="1048" text-anchor="middle" font-size="20" fill="#6b7280">Authorized Signature</text>
  </g>
</svg>`;
}

async function renderCertificatePng(opts) {
  const svg = buildCertificateSvg(opts);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { buildCertificateSvg, renderCertificatePng, formatDate };
