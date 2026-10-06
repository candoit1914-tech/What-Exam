const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const servers = [
  { name: 'backend', script: 'src/server.js' },
  { name: 'frontend', script: 'src/frontend.js' },
];

const procs = servers.map(({ name, script }) => {
  const child = spawn(process.execPath, [script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    // Don't leave the surviving server running orphaned — stop them all.
    for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
    process.exit(code || 0);
  });
  return child;
});

function shutdown() {
  for (const p of procs) { try { p.kill(); } catch { /* ignore */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
