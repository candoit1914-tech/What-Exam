'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('the retired NVIDIA fallback setting is upgraded to the current model', () => {
  const script = [
    "process.env.CLAUDE_MODEL = 'nvidia/nemotron-3-super-120b-a12b';",
    "process.env.CLAUDE_BASE_URL = 'https://integrate.api.nvidia.com/v1';",
    "process.env.CLAUDE_API_KEY = 'test-placeholder';",
    "process.stdout.write(require('./src/config').claude.model);",
  ].join('\n');
  const model = execFileSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
  });

  assert.equal(model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
});
