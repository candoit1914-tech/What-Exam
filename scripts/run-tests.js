// Per-file test runner: `node scripts/run-tests.js [name-filter]`
// Prints a one-line verdict per test file, then the failing test names.
// (node's own reporter stops at the first crashing file, which hides the rest.)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const files = fs.readdirSync(path.join(__dirname, '..', 'test'))
  .filter((f) => f.endsWith('.test.js') && f.includes(filter))
  .sort();

let totalFail = 0;
const failing = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--test', path.join('test', f)], {
    encoding: 'utf8',
    timeout: 180000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  // The reporter is spec (not TAP) when stdout is a pipe here, so the summary
  // lines read "ℹ pass 11" / "ℹ fail 0" rather than "# pass 11".
  const pass = (out.match(/\bpass (\d+)/) || [])[1];
  const fail = (out.match(/\bfail (\d+)/) || [])[1];
  const crashed = !/\bpass \d+/.test(out);
  const bad = (out.match(/^\u2716 .*$/gm) || []).map((l) => l.replace(/^\u2716\s*/, ''));
  totalFail += Number(fail || 0) + (crashed ? 1 : 0);
  console.log(
    `${crashed ? 'CRASH' : Number(fail) > 0 ? 'FAIL ' : 'ok   '} ${f}  pass=${pass || '?'} fail=${fail || '?'}${crashed ? ' (no summary — process died)' : ''}`
  );
  bad.forEach((b) => failing.push(`${f} :: ${b}`));
}
console.log(`\n=== ${totalFail} failing across ${files.length} files ===`);
failing.forEach((f) => console.log(` - ${f}`));
