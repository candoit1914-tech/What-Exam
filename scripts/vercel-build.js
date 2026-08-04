const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'public');
const dest = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

for (const f of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  console.log('Copied:', f);
}
console.log('Build complete → dist/');
