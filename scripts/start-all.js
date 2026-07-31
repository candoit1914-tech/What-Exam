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
    process.exit(code || 0);
  });
  return child;
});

process.on('SIGINT', () => {
  for (const p of procs) p.kill();
  process.exit(0);
});
